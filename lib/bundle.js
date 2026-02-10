/**
 * @file lib/bundle.js
 * @description Double-Loading Fix: "Clean ID + Implicit Resolution" Strategy
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Filter modules based on the exclusion list.
 * @param {Array} bundles - The list of bundles to process.
 * @param {Array} exclusions - The list of module prefixes to exclude.
 * @returns {Array} The filtered bundles.
 */
const applyExclusions = (bundles, exclusions) => {
    if (!exclusions || exclusions.length === 0) return bundles;

    consola.info(`🛡️  Applying ${exclusions.length} exclusion rules...`);

    bundles.forEach(bundle => {
        const originalCount = Object.keys(bundle.modules).length;
        
        // Filter the modules object keys
        Object.keys(bundle.modules).forEach(moduleName => {
            const isExcluded = exclusions.some(rule => 
                moduleName === rule || moduleName.startsWith(rule)
            );

            if (isExcluded) {
                delete bundle.modules[moduleName];
            }
        });

        const newCount = Object.keys(bundle.modules).length;
        if (originalCount !== newCount) {
            consola.debug(`   - [${bundle.name}] Removed ${originalCount - newCount} modules.`);
        }
    });

    return bundles;
};

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
 * Generates the RequireJS configuration.
 * * DOUBLE LOADING FIX:
 * 1. ID: Keep the standard ID without extension (e.g., 'magepack/bundle-vendor').
 * 2. PATHS: Map this ID to the path WITHOUT extension.
 * - RequireJS resolves 'magepack/bundle-vendor' -> 'magepack/bundle-vendor'
 * - Magento Resolver detects minification and dynamically adds '.min.js' -> 'magepack/bundle-vendor.min.js'
 * * This satisfies both RequireJS (finding its ID) and the Browser (loading the correct file).
 * * @param {Array} config - The bundle configuration.
 * @returns {string} The RequireJS config string.
 */
const buildRequireConfigContent = (config) => {
    const bundles = {};
    const paths = {};
    
    config.forEach((bundle) => {
        if (!bundle || !bundle.name || !bundle.modules) return;

        // 1. Standard Logical ID (e.g., 'magepack/bundle-vendor')
        const bundleId = `magepack/bundle-${bundle.name}`;
        
        // 2. Abstract Physical Path (e.g., 'magepack/bundle-vendor')
        // We DO NOT add '.min' here; Magento will add it dynamically.
        const bundlePath = `magepack/bundle-${bundle.name}`;

        const moduleNames = Array.isArray(bundle.modules) 
            ? bundle.modules 
            : Object.keys(bundle.modules);

        // Module normalization
        bundles[bundleId] = moduleNames.map((f) => f.replace(/\.js$/, ''));
        
        // 3. Explicit Mapping
        // Force RequireJS to associate the ID with the path.
        paths[bundleId] = bundlePath;
    });

    return `require.config({
    bundles: ${JSON.stringify(bundles)},
    paths: ${JSON.stringify(paths)}
});`;
};

async function injectConfigIntoMain(localePath, newConfigContent) {
    // Target both potential files to be sure
    const targets = ['requirejs-config.js', 'requirejs-config.min.js'];
    
    for (const fileName of targets) {
        const mainConfigPath = path.join(localePath, fileName);
        const label = path.basename(mainConfigPath);

        try {
            await fs.access(mainConfigPath);
            
            let mainConfig = await fs.readFile(mainConfigPath, 'utf8');
            const startMarker = '/* MAGEPACK START */';
            const endMarker = '/* MAGEPACK END */';
            
            const cleanRegex = new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, 'g');
            mainConfig = mainConfig.replace(cleanRegex, '');

            const injection = `${startMarker}${newConfigContent}${endMarker}`;
            const finalContent = `${mainConfig.trim()};\n${injection}`;

            await fs.writeFile(mainConfigPath, finalContent, 'utf8');
            consola.success(`   ✅ Config injected into: ${label}`);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                consola.warn(`   ⚠️  Injection failed for ${label}: ${e.message}`);
            }
        }
    }
}

async function processLocale(locale, config, options) {
    const localePath = path.join(process.cwd(), 'pub/static/frontend', locale.vendor, locale.name, locale.code);
    const label = `${locale.vendor}/${locale.name} (${locale.code})`;

    consola.start(`Bundling ${label}...`);

    try {
        await cleanMagepackDirectory(localePath);

        const detectedMinification = checkMinifyOn([localePath]);
        const isMinifyOn = options.minify || detectedMinification;

        if (options.minify && !detectedMinification) {
            consola.info(`   [${label}] Forced minification enabled.`);
        }

        // 1. Create .js and .min.js files
        await Promise.all(
            config.map(bundle => processBundle(bundle, localePath, options, isMinifyOn))
        );

        // 2. Generate Configuration (Note: isMinifyOn is no longer passed as logic is universal)
        const configContent = buildRequireConfigContent(config);
        
        // 3. Injection
        await injectConfigIntoMain(localePath, configContent);

    } catch (e) {
        consola.error(`❌ Failed to process ${label}:`, e);
        throw e;
    }
}

export default async (configPath, globPattern, sourcemap, minify, minifyStrategy, theme) => {
    const require = createRequire(import.meta.url);
    const absConfigPath = path.resolve(process.cwd(), configPath);
    const rawConfig = require(absConfigPath);
    
    // --- NEW LOGIC: Handle Object Config & Exclusions ---
    let bundles = [];
    let exclusions = [];

    if (Array.isArray(rawConfig)) {
        // Legacy Format support (Array only)
        bundles = rawConfig;
    } else {
        // New Object Format ({ bundles: [], exclusions: [] })
        bundles = rawConfig.bundles || [];
        exclusions = rawConfig.exclusions || [];
    }

    if (!bundles || bundles.length === 0) {
        consola.error("Invalid configuration: 'bundles' list is empty.");
        process.exit(1);
    }

    // Apply exclusion rules BEFORE processing
    bundles = applyExclusions(bundles, exclusions);
    // ----------------------------------------------------

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
        locales.map(locale => processLocale(locale, bundles, options))
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
