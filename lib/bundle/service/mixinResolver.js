/**
 * @file lib/bundle/service/mixinResolver.js
 * @description Resolves RequireJS mixin declarations from Magento's deployed config files.
 *
 * Magento's `mixins!` RequireJS plugin intercepts module loading via `require.load()`.
 * When a module is bundled by Magepack, `require.load()` is never called — RequireJS
 * resolves the module directly from its internal registry after executing the bundle's
 * `define()` calls. This means mixin factories are never invoked for bundled targets.
 *
 * This service bridges that gap by:
 *   1. Parsing the deployed `requirejs-config.js` to extract `config.mixins` declarations.
 *   2. Building exclusion sets for mixin targets and mixin modules.
 *   3. Providing these sets to the processor/orchestrator to remove affected modules
 *      from bundles, forcing RequireJS to load them individually via `require.load()`,
 *      which restores proper mixin interception.
 *
 * @module bundle/service/mixinResolver
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.1.0: Initial implementation. Addresses the fundamental incompatibility between
 *     Magepack's `require.config({bundles:...})` declarations and Magento's `mixins!`
 *     plugin, which relies on `require.load()` interception that bundled modules bypass.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { FILES } from '../../utils/constants.js';

/**
 * Extracts all `config.mixins` declarations from a RequireJS configuration file.
 *
 * Magento's merged `requirejs-config.js` is a series of IIFEs, each calling
 * `require.config(cfg)` with a configuration object. Mixin declarations live
 * under `cfg.config.mixins`.
 *
 * This function uses a sandboxed `new Function()` evaluation with mocked
 * `require.config` / `requirejs.config` to capture all mixin declarations
 * across all config calls. This approach handles variable references, computed
 * properties, and minified code — unlike AST-based extraction which would
 * require full variable resolution.
 *
 * Security note: The evaluated content is our own deployed static file,
 * not user input. This is acceptable in a build-tool context (same trust
 * level as Puppeteer, which opens a full browser).
 *
 * @param {string} configContent - The raw content of `requirejs-config.js`.
 * @returns {Record<string, Record<string, boolean>>} Merged mixin map.
 *   Keys are mixin target module IDs, values are objects mapping mixin module
 *   IDs to their enabled state (true/false).
 *
 * @example
 *   const mixins = extractMixinsFromConfig(configContent);
 *   // => {
 *   //   'Magento_Swatches/js/swatch-renderer': {
 *   //     'Amadeco_AdvancedAvailability/js/mixin/swatch-renderer-mixin': true,
 *   //     'Yireo_Webp2/js/swatch-renderer-mixin': true
 *   //   }
 *   // }
 */
const extractMixinsFromConfig = (configContent) => {
    /** @type {Record<string, Record<string, boolean>>} */
    const mergedMixins = {};

    /**
     * Captures `config.mixins` from a `require.config()` call.
     *
     * @param {Object} cfg - The configuration object passed to `require.config()`.
     */
    const configCaptor = (cfg) => {
        if (!cfg || typeof cfg !== 'object') {
            return;
        }

        const mixinBlock = cfg.config?.mixins;

        if (!mixinBlock || typeof mixinBlock !== 'object') {
            return;
        }

        for (const [targetModule, mixinMap] of Object.entries(mixinBlock)) {
            if (!mixinMap || typeof mixinMap !== 'object') {
                continue;
            }

            if (!mergedMixins[targetModule]) {
                mergedMixins[targetModule] = {};
            }

            Object.assign(mergedMixins[targetModule], mixinMap);
        }
    };

    // Build mock objects that capture config calls.
    // Both `require` and `requirejs` must be mocked because Magento's merged config
    // may use either form depending on which module contributed the config block.
    const mockFn = () => {};
    const mockRequire = Object.assign(mockFn, { config: configCaptor });

    const mockRequirejs = Object.assign(
        (...args) => { /* noop: swallow require([...], cb) calls */ },
        { config: configCaptor }
    );

    // `define` is also present in some config files (e.g., text plugin defines).
    const mockDefine = Object.assign(
        (...args) => { /* noop */ },
        { amd: true }
    );

    try {
        // eslint-disable-next-line no-new-func
        const sandbox = new Function(
            'require', 'requirejs', 'define', 'window', 'document',
            configContent
        );

        sandbox(
            mockRequire,
            mockRequirejs,
            mockDefine,
            {},  // mock window
            {}   // mock document
        );
    } catch (e) {
        consola.debug(`   ⚠️  Mixin extraction: partial parse (${e.message}). Continuing with captured data.`);
        // Partial results are still usable — some config blocks may have been captured
        // before the error. This is acceptable because the alternative (no mixin awareness)
        // is strictly worse.
    }

    return mergedMixins;
};

/**
 * Builds the exclusion sets from a parsed mixin configuration.
 *
 * Two distinct sets are produced:
 *   - **targets**: Module IDs that have one or more active mixins registered.
 *     These must not be bundled because their resolution must go through
 *     `require.load()` → `mixins!` plugin → mixin application chain.
 *   - **mixinModules**: The mixin factory module IDs themselves.
 *     These are never `require()`d by application code — only by the `mixins!`
 *     plugin during the interception chain. Bundling them is pointless (dead code)
 *     and wastes bundle size.
 *
 * Only **active** mixins (value === true) are considered. Disabled mixins
 * (value === false) are ignored — they were explicitly turned off by a
 * downstream module via `requirejs-config.js`.
 *
 * @param {Record<string, Record<string, boolean>>} mixinConfig - The merged mixin map.
 * @returns {{ targets: Set<string>, mixinModules: Set<string> }} The exclusion sets.
 */
const buildExclusionSets = (mixinConfig) => {
    /** @type {Set<string>} */
    const targets = new Set();

    /** @type {Set<string>} */
    const mixinModules = new Set();

    for (const [targetModule, mixinMap] of Object.entries(mixinConfig)) {
        const activeMixins = Object.entries(mixinMap)
            .filter(([, enabled]) => enabled === true)
            .map(([mixinId]) => mixinId);

        if (activeMixins.length > 0) {
            targets.add(targetModule);
            activeMixins.forEach((m) => mixinModules.add(m));
        }
    }

    return { targets, mixinModules };
};

/**
 * Resolves mixin-affected modules for a specific locale.
 *
 * Reads the appropriate `requirejs-config.js` file (minified or not),
 * extracts all mixin declarations, and returns the exclusion sets that
 * the bundle processor must respect.
 *
 * @async
 * @param {string} localePath - Absolute path to the locale's static directory
 *   (e.g., `pub/static/frontend/Amadeco/future/fr_FR`).
 * @param {boolean} isMinifyOn - Whether to read the minified config variant.
 * @returns {Promise<{ targets: Set<string>, mixinModules: Set<string> }>}
 *   The exclusion sets. Returns empty sets if the config file is missing
 *   or unparseable (graceful degradation — bundling proceeds without
 *   mixin awareness, matching the previous behavior).
 *
 * @example
 *   const exclusions = await resolveMixinExclusions(localePath, true);
 *   console.log(exclusions.targets);
 *   // => Set { 'Magento_Swatches/js/swatch-renderer', 'Magento_ConfigurableProduct/js/configurable', ... }
 *   console.log(exclusions.mixinModules);
 *   // => Set { 'Amadeco_AdvancedAvailability/js/mixin/swatch-renderer-mixin', ... }
 */
export const resolveMixinExclusions = async (localePath, isMinifyOn) => {
    const emptyResult = {
        targets: new Set(),
        mixinModules: new Set(),
    };

    const configFileName = isMinifyOn
        ? FILES.REQUIREJS_CONFIG_MIN
        : FILES.REQUIREJS_CONFIG;

    const configPath = path.join(localePath, configFileName);

    try {
        await fs.access(configPath);
    } catch {
        consola.debug(`   ℹ️  No ${configFileName} found at ${localePath}. Mixin exclusion skipped.`);
        return emptyResult;
    }

    try {
        const configContent = await fs.readFile(configPath, 'utf8');
        const mixinConfig = extractMixinsFromConfig(configContent);
        const exclusions = buildExclusionSets(mixinConfig);

        if (exclusions.targets.size > 0) {
            consola.info(
                `   🔗 Detected ${exclusions.targets.size} mixin target(s) and ` +
                `${exclusions.mixinModules.size} mixin module(s) to exclude from bundles.`
            );
            consola.debug(
                `      Targets: ${[...exclusions.targets].join(', ')}`
            );
        }

        return exclusions;
    } catch (e) {
        consola.warn(`   ⚠️  Failed to resolve mixin config: ${e.message}. Proceeding without mixin exclusion.`);
        return emptyResult;
    }
};
