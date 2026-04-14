/**
 * @file lib/bundle/service/bundleCache.js
 * @description Incremental bundle cache using content-addressable hashing.
 *
 * Skips re-processing unchanged bundles by hashing the module map and build
 * options. On a cache hit, bundle files are copied from the previous `magepack/`
 * output into the new `magepack_build/` directory, avoiding costly Terser +
 * compression work for unmodified bundles.
 *
 * Cache file location: `{localePath}/.magepack-cache.json`
 *
 * Cache entry shape:
 * ```json
 * {
 *   "vendor": {
 *     "hash": "a1b2c3d4e5f6a7b8",
 *     "moduleKeys": ["jquery/jquery", "underscore", ...]
 *   }
 * }
 * ```
 *
 * `moduleKeys` stores the pruned module list (after ghost-module removal and
 * mixin absorption by `processBundle`). On a cache hit this list is restored
 * onto `bundle.modules` so that `configInjector.js` generates the same
 * `require.config({bundles:…})` declaration as the previous build without
 * re-running the full pipeline.
 *
 * @module bundle/service/bundleCache
 * @author Amadeco Dev Team
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import consola from 'consola';
import { PATHS } from '../../utils/constants.js';

const CACHE_FILENAME = '.magepack-cache.json';

/**
 * Computes a deterministic 16-char hex hash for a bundle configuration.
 *
 * The hash incorporates:
 *   - Sorted module entries (module ID → path pairs)
 *   - Whether minification is active
 *   - The effective Terser strategy ('safe' | 'aggressive' | 'none')
 *
 * Any change to the module list, module paths, or build strategy invalidates
 * the cache entry, forcing a full rebuild for that bundle.
 *
 * @param {Object} bundle - The bundle configuration object.
 * @param {string} bundle.name - Bundle identifier.
 * @param {Object<string, string>} bundle.modules - Map of module IDs to file paths.
 * @param {boolean} isMinifyOn - Whether minification is enabled for this locale.
 * @param {string} [minifyStrategy='safe'] - Terser strategy ('safe' | 'aggressive').
 * @returns {string} A 16-character lowercase hex hash.
 */
export const computeBundleHash = (bundle, isMinifyOn, minifyStrategy = 'safe') => {
    const sortedModules = Object.entries(bundle.modules || {})
        .sort(([a], [b]) => a.localeCompare(b));

    const payload = JSON.stringify({
        name: bundle.name,
        modules: sortedModules,
        minify: isMinifyOn,
        strategy: isMinifyOn ? minifyStrategy : 'none',
    });

    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
};

/**
 * Loads the bundle cache from disk.
 *
 * Returns an empty object if the cache file does not exist or cannot be parsed,
 * ensuring a graceful fallback to a full rebuild on first run or corruption.
 *
 * @param {string} localePath - Absolute path to the locale's static directory.
 * @returns {Promise<Object>} The parsed cache object (may be empty `{}`).
 */
export const loadCache = async (localePath) => {
    const cachePath = path.join(localePath, CACHE_FILENAME);
    try {
        const raw = await fs.readFile(cachePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
};

/**
 * Persists the updated cache object to disk.
 *
 * Failures are logged as warnings but do not abort the build — the next run
 * simply performs a full rebuild and tries to write the cache again.
 *
 * @param {string} localePath - Absolute path to the locale's static directory.
 * @param {Object} cache - The cache object to persist.
 * @returns {Promise<void>}
 */
export const saveCache = async (localePath, cache) => {
    const cachePath = path.join(localePath, CACHE_FILENAME);
    try {
        await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
    } catch (e) {
        consola.warn(`⚠️  Could not write bundle cache at ${cachePath}: ${e.message}`);
    }
};

/**
 * Checks whether a bundle can be restored from the previous build.
 *
 * A cache hit requires ALL of the following:
 *   1. The cache has an entry for this bundle name.
 *   2. The stored hash matches the computed hash for this build.
 *   3. The primary JS output file still exists in the previous `magepack/` directory.
 *
 * Condition 3 guards against manual deletion of the output directory between builds.
 *
 * @param {string} localePath - Absolute path to the locale's static directory.
 * @param {string} bundleName - The bundle identifier.
 * @param {string} currentHash - The computed hash for this build invocation.
 * @param {boolean} isMinifyOn - Whether minification is active.
 * @param {Object} cache - The loaded cache object from `loadCache`.
 * @returns {Promise<boolean>} True if the bundle output can be reused from cache.
 */
export const isCacheHit = async (localePath, bundleName, currentHash, isMinifyOn, cache) => {
    const entry = cache[bundleName];
    if (!entry || entry.hash !== currentHash) return false;

    const ext = isMinifyOn ? '.min.js' : '.js';
    const prevBundlePath = path.join(localePath, PATHS.MAGEPACK_DIR, `bundle-${bundleName}${ext}`);

    try {
        await fs.access(prevBundlePath);
        return true;
    } catch {
        return false;
    }
};

/**
 * Restores a cached bundle into the new build directory.
 *
 * Copies the primary JS file and all static compressed variants (.gz, .br, .zst)
 * from the previous `magepack/` output into `magepack_build/`. Missing compressed
 * variants are silently skipped — they may not exist if compression was disabled.
 *
 * Also restores the pruned module list onto `bundle.modules` so that
 * `configInjector.js` emits the same `require.config({bundles:…})` declaration
 * as the previous build (with ghost modules and absorbed mixins already removed).
 *
 * @param {string} localePath - Absolute path to the locale's static directory.
 * @param {string} buildDir - Absolute path to the temporary `magepack_build/` directory.
 * @param {Object} bundle - The bundle configuration object. **Mutated in place** to
 *   restore the previously pruned module list.
 * @param {boolean} isMinifyOn - Whether minification is active.
 * @param {Object} cacheEntry - The cache entry for this bundle (`{ hash, moduleKeys }`).
 * @returns {Promise<void>}
 */
export const restoreFromCache = async (localePath, buildDir, bundle, isMinifyOn, cacheEntry) => {
    const ext = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${ext}`;
    const srcDir = path.join(localePath, PATHS.MAGEPACK_DIR);

    // Copy primary file + all compressed variants (optional).
    const filesToCopy = [
        bundleFilename,
        `${bundleFilename}.gz`,
        `${bundleFilename}.br`,
        `${bundleFilename}.zst`,
        `${bundleFilename}.map`,
    ];

    await Promise.allSettled(
        filesToCopy.map(async (filename) => {
            try {
                await fs.copyFile(
                    path.join(srcDir, filename),
                    path.join(buildDir, filename)
                );
            } catch {
                // Compressed variants and source maps are optional — skip silently.
            }
        })
    );

    // Restore the pruned module list so configInjector emits the correct
    // require.config({bundles:…}) without re-running processBundle.
    if (Array.isArray(cacheEntry.moduleKeys)) {
        const prunedKeys = new Set(cacheEntry.moduleKeys);
        for (const key of Object.keys(bundle.modules)) {
            if (!prunedKeys.has(key)) {
                delete bundle.modules[key];
            }
        }
    }
};
