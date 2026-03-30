/**
 * @file lib/bundle/service/mixinResolver.js
 * @description Resolves RequireJS mixin declarations from Magento's deployed config files.
 *
 * Magento's `mixins!` RequireJS plugin intercepts module loading via `require.load()`.
 * When a module is bundled by Magepack, `require.load()` is never called — RequireJS
 * resolves the module directly from its internal registry after executing the bundle's
 * `define()` calls. This means mixin factories are never invoked for bundled targets.
 *
 * This service bridges that gap by parsing the deployed `requirejs-config.js` to extract
 * `config.mixins` declarations, enabling the bundle processor to pre-apply mixin chains
 * at build time — producing composite modules that are already "mixined" when RequireJS
 * resolves them from the bundle.
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
 * `require.config(cfg)`. Mixin declarations live under `cfg.config.mixins`.
 *
 * Uses a sandboxed `new Function()` evaluation with mocked `require.config` /
 * `requirejs.config` to capture all mixin declarations across all config calls.
 * This handles variable references, computed properties, and minified code —
 * unlike AST-based extraction which would require full variable resolution.
 *
 * Security note: The evaluated content is our own deployed static file,
 * not user input. Same trust level as Puppeteer (which opens a full browser).
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
    const mockFn = () => {};
    const mockRequire = Object.assign(mockFn, { config: configCaptor });
    const mockRequirejs = Object.assign(
        (...args) => { /* noop: swallow require([...], cb) calls */ },
        { config: configCaptor }
    );
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

        sandbox(mockRequire, mockRequirejs, mockDefine, {}, {});
    } catch (e) {
        consola.debug(`   ⚠️  Mixin extraction: partial parse (${e.message}). Continuing with captured data.`);
    }

    return mergedMixins;
};

/**
 * Builds a structured mixin map from the raw extracted configuration.
 *
 * For each mixin target present in the given bundle modules, returns the ordered
 * list of active mixin module IDs. Disabled mixins (value === false) are excluded.
 *
 * @param {Record<string, Record<string, boolean>>} mixinConfig - The merged mixin map.
 * @param {Set<string>} bundledModuleIds - Set of module IDs present in the current bundle.
 * @returns {MixinMap} Map from target module ID to its mixin metadata.
 *
 * @typedef {Map<string, MixinTargetInfo>} MixinMap
 * @typedef {Object} MixinTargetInfo
 * @property {string[]} mixinIds - Ordered list of active mixin module IDs.
 * @property {string[]} bundledMixinIds - Subset of mixinIds that are also in this bundle.
 * @property {string[]} externalMixinIds - Subset of mixinIds NOT in this bundle.
 */
const buildMixinMap = (mixinConfig, bundledModuleIds) => {
    /** @type {MixinMap} */
    const mixinMap = new Map();

    for (const [targetModule, mixinEntries] of Object.entries(mixinConfig)) {
        // Only process targets that are actually in this bundle
        if (!bundledModuleIds.has(targetModule)) {
            continue;
        }

        const activeMixins = Object.entries(mixinEntries)
            .filter(([, enabled]) => enabled === true)
            .map(([mixinId]) => mixinId);

        if (activeMixins.length === 0) {
            continue;
        }

        const bundledMixinIds = activeMixins.filter((id) => bundledModuleIds.has(id));
        const externalMixinIds = activeMixins.filter((id) => !bundledModuleIds.has(id));

        mixinMap.set(targetModule, {
            mixinIds: activeMixins,
            bundledMixinIds,
            externalMixinIds,
        });
    }

    return mixinMap;
};

/**
 * Resolves mixin configuration for a specific locale.
 *
 * Reads the appropriate `requirejs-config.js` file, extracts all mixin declarations,
 * and returns both the raw mixin config and a factory for building bundle-specific
 * mixin maps.
 *
 * @async
 * @param {string} localePath - Absolute path to the locale's static directory.
 * @param {boolean} isMinifyOn - Whether to read the minified config variant.
 * @returns {Promise<MixinResolverResult>}
 *
 * @typedef {Object} MixinResolverResult
 * @property {Record<string, Record<string, boolean>>} mixinConfig - Raw mixin declarations.
 * @property {function(Set<string>): MixinMap} buildMapForBundle - Factory that creates
 *   a mixin map filtered for a specific bundle's module set.
 * @property {Set<string>} allMixinModuleIds - Set of all known mixin factory module IDs
 *   across all targets. Used for identification during processing.
 */
export const resolveMixins = async (localePath, isMinifyOn) => {
    const emptyResult = {
        mixinConfig: {},
        buildMapForBundle: () => new Map(),
        allMixinModuleIds: new Set(),
    };

    const configFileName = isMinifyOn
        ? FILES.REQUIREJS_CONFIG_MIN
        : FILES.REQUIREJS_CONFIG;

    const configPath = path.join(localePath, configFileName);

    try {
        await fs.access(configPath);
    } catch {
        consola.debug(`   ℹ️  No ${configFileName} found at ${localePath}. Mixin pre-application skipped.`);
        return emptyResult;
    }

    try {
        const configContent = await fs.readFile(configPath, 'utf8');
        const mixinConfig = extractMixinsFromConfig(configContent);

        // Collect all mixin module IDs across all targets
        /** @type {Set<string>} */
        const allMixinModuleIds = new Set();

        for (const mixinEntries of Object.values(mixinConfig)) {
            for (const [mixinId, enabled] of Object.entries(mixinEntries)) {
                if (enabled === true) {
                    allMixinModuleIds.add(mixinId);
                }
            }
        }

        const targetCount = Object.keys(mixinConfig).length;

        if (targetCount > 0) {
            consola.info(
                `   🔗 Detected ${targetCount} mixin target(s), ` +
                `${allMixinModuleIds.size} active mixin module(s).`
            );
        }

        return {
            mixinConfig,
            buildMapForBundle: (bundledModuleIds) => buildMixinMap(mixinConfig, bundledModuleIds),
            allMixinModuleIds,
        };
    } catch (e) {
        consola.warn(`   ⚠️  Failed to resolve mixin config: ${e.message}. Proceeding without mixin pre-application.`);
        return emptyResult;
    }
};
