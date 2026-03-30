/**
 * @file lib/bundle.js
 * @description Main bundling orchestrator for Magepack.
 *
 * @changelog
 *   - v3.1.0: Added mixin-aware composition pipeline. The orchestrator now:
 *     1. Resolves mixin declarations from the locale's `requirejs-config.js`.
 *     2. Builds per-bundle mixin maps (which targets have bundled mixins).
 *     3. Passes the maps to `processBundle()` for build-time composition.
 *     This eliminates the fundamental incompatibility between Magepack bundles
 *     and Magento's `mixins!` RequireJS plugin, without sacrificing bundling.
 *   - v3.1.0: Fixed cross-locale mutation bug. The shared `config` array is now
 *     deep-cloned per locale before processing. Both ghost module pruning and
 *     mixin composition mutate `bundle.modules` in place.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import consola from 'consola';
import { PATHS } from './utils/constants.js';

// Internal modules imports
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import { processBundle } from './bundle/processor.js';
import { updateSriHashes } from './bundle/service/sriUpdater.js';
import { injectRequireConfig } from './bundle/service/configInjector.js';
import { resolveLocaleMixins, buildBundleMixinMap } from './bundle/service/mixinResolver.js';

/**
 * Filters out modules from bundles based on a list of exclusion prefixes.
 *
 * @param {Array<Object>} bundles - The list of bundle configurations to process.
 * @param {string[]} exclusions - An array of module name prefixes to exclude.
 * @returns {Array<Object>} The filtered list of bundles.
 */
const applyExclusions = (bundles, exclusions) => {
    if (!exclusions || exclusions.length === 0) return bundles;

    consola.info(`🛡️  Applying ${exclusions.length} exclusion rules...`);

    bundles.forEach(bundle => {
        const originalCount = Object.keys(bundle.modules).length;

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

/**
 * Prepares the temporary build directory for a specific locale.
 *
 * @param {string} localePath - The absolute path to the locale's static directory.
 * @returns {Promise<string>} The absolute path to the created 'magepack_build' directory.
 */
const prepareBuildDirectory = async (localePath) => {
    const buildDir = path.join(localePath, PATHS.BUILD_DIR);
    try {
        await fs.rm(buildDir, { recursive: true, force: true });
        await fs.mkdir(buildDir, { recursive: true });
        return buildDir;
    } catch (e) {
        consola.error(`❌ Could not create temp directory ${buildDir}: ${e.message}`);
        throw e;
    }
};

/**
 * Performs an atomic swap of the build directory to the production directory.
 *
 * @param {string} localePath - The absolute path to the locale's static directory.
 * @param {string} buildDir - The absolute path to the temporary build directory.
 */
const finalizeBuild = async (localePath, buildDir) => {
    const finalDir = path.join(localePath, PATHS.MAGEPACK_DIR);
    const backupDir = path.join(localePath, PATHS.BACKUP_DIR);

    try {
        let previousExists = false;
        try {
            await fs.access(finalDir);
            previousExists = true;
        } catch { /* ignore */ }

        if (previousExists) {
            await fs.rm(backupDir, { recursive: true, force: true });
            await fs.rename(finalDir, backupDir);
        }

        await fs.rename(buildDir, finalDir);

        if (previousExists) {
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    } catch (e) {
        consola.error(`❌ Atomic swap failed for ${localePath}.`);
        consola.error(`   Detailed error: ${e.message}`);
        throw e;
    }
};

/**
 * Processes a single locale: resolves mixins, builds bundles, performs atomic swap,
 * and updates RequireJS config.
 *
 * @param {Object} locale - The locale object (vendor, name, code).
 * @param {Array<Object>} sharedConfig - The shared bundle configuration (read-only).
 * @param {Object} options - Global configuration object containing build parameters.
 */
async function processLocale(locale, sharedConfig, options) {
    const localePath = path.join(process.cwd(), PATHS.STATIC_FRONTEND, locale.vendor, locale.name, locale.code);
    const label = `${locale.vendor}/${locale.name} (${locale.code})`;

    consola.start(`Bundling ${label}...`);

    try {
        // 1. PREPARE: Create temporary build directory
        const buildDir = await prepareBuildDirectory(localePath);

        const detectedMinification = await checkMinifyOn(localePath);
        const isMinifyOn = options.minify || detectedMinification;

        if (options.minify && !detectedMinification) {
            consola.info(`   [${label}] Forced minification enabled.`);
        }

        // 1.5 CLONE: Deep-clone config to prevent cross-locale mutation.
        //     Both ghost module pruning (processor.js) and mixin composition
        //     mutate bundle.modules in place. Without cloning, concurrent
        //     locale processing via Promise.allSettled would corrupt shared state.
        const localeConfig = structuredClone(sharedConfig);

        // 1.6 MIXIN RESOLUTION: Parse requirejs-config.js once per locale.
        //     The resolver extracts all config.mixins declarations and builds
        //     the set of all known mixin module IDs.
        const { fullMixinConfig, allMixinModuleIds } = await resolveLocaleMixins(localePath, isMinifyOn);

        // 2. BUILD: Generate bundles into the temporary directory.
        //    Each bundle receives its own mixin map, built from the locale's
        //    mixin config filtered by the bundle's module list.
        await Promise.all(
            localeConfig.map((bundle) => {
                const mixinMap = buildBundleMixinMap(fullMixinConfig, bundle.modules);

                return processBundle(
                    bundle,
                    localePath,
                    buildDir,
                    options,
                    isMinifyOn,
                    mixinMap,
                    allMixinModuleIds
                );
            })
        );

        // 3. SWAP: Atomic replacement of the old folder with the new one
        await finalizeBuild(localePath, buildDir);

        // 4. CONFIG: Generate and inject RequireJS configuration.
        //    localeConfig has been mutated by the processor:
        //      - Ghost modules pruned (missing on disk)
        //      - Absorbed mixin modules removed (composed into targets)
        //    configInjector uses the resulting bundle.modules to generate
        //    require.config({bundles:...}). Targets remain declared (consumers
        //    can require them), but absorbed mixins are NOT declared (prevents
        //    double-application by the mixins! plugin on non-bundled pages).
        await injectRequireConfig(localePath, localeConfig, isMinifyOn);

    } catch (e) {
        consola.error(`❌ Failed to process ${label}:`, e);
        throw e;
    }
}

/**
 * Main entry point for the bundling command.
 *
 * @param {Object} options - Global configuration object passed from CLI.
 */
export default async (options) => {
    const require = createRequire(import.meta.url);
    const absConfigPath = path.resolve(process.cwd(), options.config);
    const rawConfig = require(absConfigPath);

    let bundles = [];
    let exclusions = [];

    if (Array.isArray(rawConfig)) {
        bundles = rawConfig;
    } else {
        bundles = rawConfig.bundles || [];
        exclusions = rawConfig.exclusions || [];
    }

    if (!bundles || bundles.length === 0) {
        consola.error("Invalid configuration: 'bundles' list is empty.");
        process.exit(1);
    }

    bundles = applyExclusions(bundles, exclusions);

    let locales = await getLocales(process.cwd());
    if (options.theme) {
        locales = locales.filter(l => `${l.vendor}/${l.name}` === options.theme);
    }

    if (locales.length === 0) {
        consola.error("No locales found matching criteria.");
        return;
    }

    consola.info(`🚀 Starting Bundle Pipeline for ${locales.length} locales...`);
    if (options.fastCompression) {
        consola.info('⚡ Fast Compression mode is enabled (optimized for CI/CD speed).');
    }

    const start = process.hrtime();

    const results = await Promise.allSettled(
        locales.map(locale => processLocale(locale, bundles, options))
    );

    const [sec, nanosec] = process.hrtime(start);
    const totalSec = (sec + nanosec / 1e9).toFixed(2);

    const failed = results.filter(r => r.status === 'rejected');

    if (failed.length > 0) {
        consola.error(`💀 Finished in ${totalSec}s with ${failed.length} errors.`);
        process.exit(1);
    } else {
        await updateSriHashes(locales, bundles);
        consola.success(`✨ All locales bundled successfully in ${totalSec}s.`);
    }
};
