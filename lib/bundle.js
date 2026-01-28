import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

// Helper to escape regex characters
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cleans the output directory to prevent stale files.
 * @param {string} localePath
 */
const cleanMagepackDirectory = async (localePath) => {
    const targetDir = path.join(localePath, 'magepack');
    try {
        await fs.rm(targetDir, { recursive: true, force: true });
        await fs.mkdir(targetDir, { recursive: true });
    } catch (e) {
        consola.warn(`⚠️  Could not clean directory ${targetDir}: ${e.message}`);
    }
};

/**
 * Generates the RequireJS configuration content.
 * FIX: We enforce explicit mapping in 'paths' to avoid ambiguity between 
 * Logical ID and Physical URL, preventing the double-loading bug.
 *
 * @param {Array<Object>} config 
 * @param {boolean} isMinifyOn 
 * @returns {string}
 */
const buildRequireConfigContent = (config, isMinifyOn) => {
    const bundles = {};
    const paths = {};
    
    // Explicit extension based on build mode
    const ext = isMinifyOn ? '.min' : '';

    config.forEach((bundle) => {
        if (!bundle || !bundle.name || !bundle.modules) return;

        // 1. Logical ID (ALWAYS without extension)
        const bundleId = `magepack/bundle-${bundle.name}`;
        
        // 2. Physical Path (relative to baseUrl)
        // RequireJS automatically appends '.js', so we only append '.min' if needed.
        // Example: 'magepack/bundle-vendor.min' -> resolves to 'magepack/bundle-vendor.min.js'
        const bundlePath = `magepack/bundle-${bundle.name}${ext}`;

        const moduleNames = Array.isArray(bundle.modules) 
            ? bundle.modules 
            : Object.keys(bundle.modules);

        // Normalize module names
        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));
        
        // 3. FORCE PATH MAPPING
        // We always map the ID to the Path. This stops RequireJS from guessing.
        // It tells RequireJS: "When you want 'magepack/bundle-vendor', ALWAYS use this specific file."
        paths[bundleId] = bundlePath;
    });

    return `require.config({
    bundles: ${JSON.stringify(bundles)},
    paths: ${JSON.stringify(paths)}
});`;
};

/**
 * Injects the configuration into BOTH regular and minified config files.
 * This ensures that regardless of Magento's mode (Dev/Prod), the config is present.
 */
async function injectConfigIntoMain(localePath, newConfigContent) {
    const targets = ['requirejs-config.js', 'requirejs-config.min.js'];
    
    for (const fileName of targets) {
        const mainConfigPath = path.join(localePath, fileName);
        const label = path.basename(mainConfigPath);

        try {
            // Check if file exists before trying to read
            await fs.access(mainConfigPath);
            
            let mainConfig = await fs.readFile(mainConfigPath, 'utf8');
            const startMarker = '/* MAGEPACK START */';
            const endMarker = '/* MAGEPACK END */';
            
            // Remove previous injection
            const cleanRegex = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'g');
            mainConfig = mainConfig.replace(cleanRegex, '');

            // Append new config
            const injection = `\n${startMarker}\n${newConfigContent}\n${endMarker}`;
            const finalContent = `${mainConfig.trim()};\n${injection}`;

            await fs.writeFile(mainConfigPath, finalContent, 'utf8');
            consola.success(`   ✅ Config injected into: ${label}`);
        } catch (e) {
            // Silently skip if file doesn't exist (normal for non-minified setups to lack .min.js)
            if (e.code !== 'ENOENT') {
                consola.warn(`   ⚠️  Injection failed for ${label}: ${e.message}`);
            }
        }
    }
}

/**
 * Processes a single locale.
 */
async function processLocale(locale, config, options) {
    const localePath = path.join(process.cwd(), 'pub/static/frontend', locale.vendor, locale.name, locale.code);
    const label = `${locale.vendor}/${locale.name} (${locale.code})`;

    consola.start(`Bundling ${label}...`);

    try {
        await cleanMagepackDirectory(localePath);

        // Auto-detect minification
        const detectedMinification = checkMinifyOn([localePath]);
        const isMinifyOn = options.minify || detectedMinification;

        if (options.minify && !detectedMinification) {
            consola.info(`   [${label}] Forced minification enabled.`);
        }

        // 1. Generate Bundles (Files)
        await Promise.all(
            config.map(bundle => processBundle(bundle, localePath, options, isMinifyOn))
        );

        // 2. Generate Config Content
        const configContent = buildRequireConfigContent(config, isMinifyOn);
        
        // 3. Inject Config (Targeting BOTH files to be safe)
        await injectConfigIntoMain(localePath, configContent);

    } catch (e) {
        consola.error(`❌ Failed to process ${label}:`, e);
        throw e;
    }
}

/**
 * Main Entry Point.
 */
export default async (configPath, globPattern, sourcemap, minify, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const absConfigPath = path.resolve(process.cwd(), configPath);
    const config = require(absConfigPath);
    const options = { glob: globPattern, sourcemap, minify, minifyStrategy };

    let locales = await getLocales(process.cwd());
    if (theme) {
        locales = locales.filter(l => `${l.vendor}/${l.name}` === theme);
    }

    if (locales.length === 0) {
        consola.error("No locales found matching criteria.");
        return;
    }

    consola.info(`🚀 Starting Bundle Pipeline for ${locales.length} locales...`);
    const start = process.hrtime();

    const results = await Promise.allSettled(
        locales.map(locale => processLocale(locale, config, options))
    );

    const [sec] = process.hrtime(start);
    const failed = results.filter(r => r.status === 'rejected');

    if (failed.length > 0) {
        consola.error(`💀 Finished in ${sec}s with ${failed.length} errors.`);
        process.exit(1);
    } else {
        consola.success(`✨ All locales bundled successfully in ${sec}s.`);
    }
};
