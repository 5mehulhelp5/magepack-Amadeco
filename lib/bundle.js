/**
 * @file lib/bundle.js
 * @description Orchestrates the bundling process, generates RequireJS config, and handles file system I/O.
 * @author Amadeco Dev Team
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

/**
 * Helper to escape regex characters.
 * @param {string} string
 * @returns {string}
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cleans the output directory to prevent stale files.
 * Uses strict recursive deletion.
 * * @param {string} localePath - Absolute path to the locale directory.
 * @returns {Promise<void>}
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
 * * FIX FOR DOUBLE LOADING:
 * We strictly separate the Bundle Logical ID from the Physical Path.
 * When Minification is ON, we allow RequireJS to resolve the .min.js automatically via baseUrl
 * or we map it without the explicit extension in the key to prevent 'foo.min.min.js' issues.
 *
 * @param {Array<Object>} config - The collected bundle configuration.
 * @param {boolean} isMinifyOn - Whether Magento minification is active.
 * @returns {string} The formatted requirejs-config.js content.
 */
const buildRequireConfigContent = (config, isMinifyOn) => {
    const bundles = {};
    const paths = {};
    
    // Suffix added to the physical filename on disk
    const fileExt = isMinifyOn ? '.min' : '';

    config.forEach((bundle) => {
        if (!bundle || !bundle.name || !bundle.modules) return;

        // 1. Logical ID: Always kept simple (e.g., 'magepack/bundle-vendor')
        // This is the ID RequireJS uses internally to track if the bundle is loaded.
        const bundleId = `magepack/bundle-${bundle.name}`;
        
        // 2. Physical Path: 
        // If minified: 'magepack/bundle-vendor.min'
        // If regular:  'magepack/bundle-vendor'
        // Note: RequireJS automatically appends '.js' to this path.
        const bundlePath = `magepack/bundle-${bundle.name}${fileExt}`;

        // Map the modules to the Logical ID
        const moduleNames = Array.isArray(bundle.modules) 
            ? bundle.modules 
            : Object.keys(bundle.modules);

        // Normalize module names (remove .js extension if present to match RequireJS registry)
        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));
        
        // 3. Path Mapping:
        // We map the Logical ID to the Physical Path.
        // This tells RequireJS: "When you want 'magepack/bundle-vendor', go get 'magepack/bundle-vendor.min.js'"
        if (bundleId !== bundlePath) {
            paths[bundleId] = bundlePath;
        }
    });

    return `require.config({
    bundles: ${JSON.stringify(bundles)},
    paths: ${JSON.stringify(paths)}
});`;
};

/**
 * Injects the configuration into the main requirejs-config.js file.
 * Handles both minified and non-minified config files.
 * * @param {string} localePath 
 * @param {boolean} isMinifyOn 
 * @param {string} newConfigContent 
 */
async function injectConfigIntoMain(localePath, isMinifyOn, newConfigContent) {
    // Detect target config file: requirejs-config.min.js (Prod) or requirejs-config.js (Dev)
    const fileName = isMinifyOn ? 'requirejs-config.min.js' : 'requirejs-config.js';
    const mainConfigPath = path.join(localePath, fileName);
    const label = path.basename(mainConfigPath);

    try {
        await fs.access(mainConfigPath);
        let mainConfig = await fs.readFile(mainConfigPath, 'utf8');

        // Markers to safely replace content on subsequent runs
        const startMarker = '/* MAGEPACK START */';
        const endMarker = '/* MAGEPACK END */';
        
        // Remove existing injection if present (RegExp handles indentation/newlines)
        const cleanRegex = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'g');
        mainConfig = mainConfig.replace(cleanRegex, '');

        // Append the new config at the end, wrapped in markers
        // We use a semicolon prefix to handle cases where the previous file didn't end cleanly.
        const injection = `\n${startMarker}\n${newConfigContent}\n${endMarker}`;
        const finalContent = `${mainConfig.trim()};\n${injection}`;

        await fs.writeFile(mainConfigPath, finalContent, 'utf8');
        consola.success(`   ✅ Config injected into: ${label}`);
    } catch (e) {
        if (e.code === 'ENOENT') {
            consola.warn(`   ⚠️  Target config not found: ${label}. Skipping injection.`);
        } else {
            consola.error(`   ❌ Injection failed for ${label}: ${e.message}`);
        }
    }
}

/**
 * Processes a single locale: Bundling + Config Injection.
 * * @param {Object} locale - { vendor, name, code }
 * @param {Array} config - Bundling configuration
 * @param {Object} options - CLI options
 */
async function processLocale(locale, config, options) {
    const localePath = path.join(process.cwd(), 'pub/static/frontend', locale.vendor, locale.name, locale.code);
    const label = `${locale.vendor}/${locale.name} (${locale.code})`;

    consola.start(`Bundling ${label}...`);

    try {
        await cleanMagepackDirectory(localePath);

        // Auto-detect minification state from the filesystem
        const detectedMinification = checkMinifyOn([localePath]);
        const isMinifyOn = options.minify || detectedMinification;

        if (options.minify && !detectedMinification) {
            consola.info(`   [${label}] Forced minification enabled via CLI.`);
        }

        // 1. Process all bundles in PARALLEL
        // This generates the actual .js / .min.js files on disk
        await Promise.all(
            config.map(bundle => processBundle(bundle, localePath, options, isMinifyOn))
        );

        // 2. Generate and Inject the RequireJS configuration
        const configContent = buildRequireConfigContent(config, isMinifyOn);
        await injectConfigIntoMain(localePath, isMinifyOn, configContent);

    } catch (e) {
        consola.error(`❌ Failed to process ${label}:`, e);
        throw e; // Re-throw to be caught by main handler
    }
}

/**
 * Main Entry Point.
 * * @param {string} configPath - Path to magepack.config.js
 * @param {string} globPattern - Optional theme filter
 * @param {boolean} sourcemap - Generate source maps
 * @param {boolean} minify - Force minify
 * @param {string} minifyStrategy - 'safe' | 'aggressive'
 * @param {string} theme - Specific theme filter (Vendor/Theme)
 */
export default async (configPath, globPattern, sourcemap, minify, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const absConfigPath = path.resolve(process.cwd(), configPath);
    
    // Dynamic require of the config file
    const config = require(absConfigPath);
    const options = { glob: globPattern, sourcemap, minify, minifyStrategy };

    // Resolve Locales
    let locales = await getLocales(process.cwd());
    if (theme) {
        locales = locales.filter(l => `${l.vendor}/${l.name}` === theme);
    }

    if (locales.length === 0) {
        consola.error("No locales found matching criteria. check 'pub/static'.");
        return;
    }

    consola.info(`🚀 Starting Bundle Pipeline for ${locales.length} locales...`);
    const start = process.hrtime();

    // Execute locales in parallel using Promise.allSettled to ensure one failure doesn't stop others
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
