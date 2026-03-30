/**
 * @file lib/bundle/service/mixinResolver.js
 * @description Resolves RequireJS mixin declarations from Magento's deployed config files
 * and builds per-bundle mixin maps for the processor's composition phase.
 *
 * This service acts as the bridge between Magento's `requirejs-config.js` mixin
 * declarations and Magepack's bundle processor. It:
 *
 *   1. Parses the deployed `requirejs-config.js` to extract all `config.mixins` blocks.
 *   2. Merges declarations across all config blocks (Magento concatenates multiple
 *      `require.config()` calls from different modules into a single file).
 *   3. For a given bundle's module list, classifies each mixin target's factories as
 *      either "bundled" (present in this bundle → will be composed at build-time) or
 *      "external" (not in this bundle → will load via `mixins!` plugin at runtime).
 *
 * @module bundle/service/mixinResolver
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.1.0: Initial implementation.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { FILES } from '../../utils/constants.js';

/**
 * @typedef {Object} MixinTargetInfo
 * @property {string[]} bundledMixinIds - Mixin module IDs present in the current bundle.
 *   These will be composed into the target at build-time by `mixinComposer.js`.
 * @property {string[]} externalMixinIds - Mixin module IDs NOT in the current bundle.
 *   These will be applied at runtime by Magento's `mixins!` RequireJS plugin.
 */

/**
 * Extracts all `config.mixins` declarations from a RequireJS configuration file.
 *
 * Magento's merged `requirejs-config.js` contains multiple IIFEs, each calling
 * `require.config(cfg)`. Mixin declarations live under `cfg.config.mixins`.
 * This function uses a sandboxed `new Function()` evaluation with mocked
 * `require.config` / `requirejs.config` to capture all declarations.
 *
 * @param {string} configContent - The raw content of `requirejs-config.js`.
 * @returns {Record<string, Record<string, boolean>>} Merged mixin map.
 */
const extractMixinsFromConfig = (configContent) => {
    /** @type {Record<string, Record<string, boolean>>} */
    const mergedMixins = {};

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

    const mockFn = () => {};
    const mockRequire = Object.assign(mockFn, { config: configCaptor });
    const mockRequirejs = Object.assign(
        (...args) => {},
        { config: configCaptor }
    );
    const mockDefine = Object.assign(
        (...args) => {},
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
        consola.debug(
            `   ⚠️  Mixin config extraction: partial parse (${e.message}). ` +
            `Continuing with captured data.`
        );
    }

    return mergedMixins;
};

/**
 * Resolves mixin configuration for a specific locale.
 *
 * @async
 * @param {string} localePath - Absolute path to the locale's static directory.
 * @param {boolean} isMinifyOn - Whether to read the minified config variant.
 * @returns {Promise<{
 *   fullMixinConfig: Record<string, Record<string, boolean>>,
 *   allMixinModuleIds: Set<string>
 * }>}
 */
export const resolveLocaleMixins = async (localePath, isMinifyOn) => {
    const emptyResult = {
        fullMixinConfig: {},
        allMixinModuleIds: new Set(),
    };

    const configFileName = isMinifyOn
        ? FILES.REQUIREJS_CONFIG_MIN
        : FILES.REQUIREJS_CONFIG;

    const configPath = path.join(localePath, configFileName);

    try {
        await fs.access(configPath);
    } catch {
        consola.debug(`   ℹ️  No ${configFileName} found at ${localePath}. Mixin resolution skipped.`);
        return emptyResult;
    }

    try {
        const configContent = await fs.readFile(configPath, 'utf8');
        const fullMixinConfig = extractMixinsFromConfig(configContent);

        /** @type {Set<string>} */
        const allMixinModuleIds = new Set();

        for (const [, mixinMap] of Object.entries(fullMixinConfig)) {
            for (const [mixinId, enabled] of Object.entries(mixinMap)) {
                if (enabled === true) {
                    allMixinModuleIds.add(mixinId);
                }
            }
        }

        const targetCount = Object.keys(fullMixinConfig).length;

        if (targetCount > 0) {
            consola.info(
                `   🔗 Resolved ${targetCount} mixin target(s) with ` +
                `${allMixinModuleIds.size} active mixin module(s).`
            );
        }

        return { fullMixinConfig, allMixinModuleIds };
    } catch (e) {
        consola.warn(`   ⚠️  Failed to resolve mixin config: ${e.message}. Proceeding without mixin composition.`);
        return emptyResult;
    }
};

/**
 * Builds a mixin map for a specific bundle.
 *
 * For each mixin target declared in the config, determines which of its mixin
 * factories are present in the bundle ("bundled") and which are not ("external").
 * Only targets that are themselves present in the bundle AND have at least one
 * bundled mixin factory are included in the result.
 *
 * @param {Record<string, Record<string, boolean>>} fullMixinConfig - The full mixin config.
 * @param {Object<string, string>} bundleModules - The bundle's `modules` map.
 * @returns {Map<string, MixinTargetInfo>} Map of target module ID → mixin classification.
 */
export const buildBundleMixinMap = (fullMixinConfig, bundleModules) => {
    /** @type {Map<string, MixinTargetInfo>} */
    const mixinMap = new Map();

    const bundleModuleIds = new Set(Object.keys(bundleModules || {}));

    for (const [targetId, mixinEntries] of Object.entries(fullMixinConfig)) {
        if (!bundleModuleIds.has(targetId)) {
            continue;
        }

        /** @type {string[]} */
        const bundledMixinIds = [];

        /** @type {string[]} */
        const externalMixinIds = [];

        for (const [mixinId, enabled] of Object.entries(mixinEntries)) {
            if (enabled !== true) {
                continue;
            }

            if (bundleModuleIds.has(mixinId)) {
                bundledMixinIds.push(mixinId);
            } else {
                externalMixinIds.push(mixinId);
            }
        }

        if (bundledMixinIds.length > 0) {
            mixinMap.set(targetId, { bundledMixinIds, externalMixinIds });
        }
    }

    return mixinMap;
};
