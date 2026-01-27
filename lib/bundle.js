import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'javascript-stringify';
import * as terser from 'terser';
import { gzipSizeSync } from 'gzip-size';
import genSourceMap from 'generate-sourcemap';

import logger from './utils/logger.js';
import getLocales from './bundle/getLocales.js';
import pathResolver from './bundle/pathResolver.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';
import * as moduleWrapper from './bundle/moduleWrapper.js';
import modulePathMapper from './bundle/moduleMapResolver.js';

/**
 * Helper to get Terser config based on strategy.
 * @param {string} strategy - 'aggressive' | 'safe'
 * @param {boolean} includeSourcemaps
 * @param {string} bundleFileName
 * @param {Object} sourceMap
 * @returns {import('terser').MinifyOptions}
 */
const getTerserConfig = (strategy, includeSourcemaps, bundleFileName, sourceMap) => {
    // Configuration de base commune (protection du scope global)
    const baseConfig = {
        module: false,
        mangle: {
            reserved: ['$', 'jQuery', 'define', 'require', 'exports', 'requirejs', 'window', 'document', 'mage'],
            toplevel: false,
        },
        format: {
            comments: false,
            ascii_only: true,
        },
        sourceMap: includeSourcemaps ? {
            content: sourceMap.getMap(),
            filename: bundleFileName,
            url: `${bundleFileName}.map`,
        } : false
    };

    if (strategy === 'safe') {
        logger.debug('Using SAFE minification strategy (ECMA 5, No Unsafe Ops).');
        return {
            ...baseConfig,
            ecma: 5, // Maximum legacy compatibility
            compress: {
                passes: 1, // Single pass is safer and faster
                drop_console: false, // Keep logs for debugging
                drop_debugger: false,
                pure_getters: false, // Assume getters might have side-effects
                unsafe: false,
                unsafe_proto: false,
                typeofs: false, // Strict typeof checks
            }
        };
    }

    // Default: Aggressive
    logger.debug('Using AGGRESSIVE minification strategy (ECMA 2020, Drop Console, Unsafe Ops).');
    return {
        ...baseConfig,
        ecma: 2020,
        compress: {
            passes: 3,
            drop_console: true,
            drop_debugger: true,
            pure_getters: true,
            unsafe: true,
            unsafe_proto: true,
            sequences: true,
            dead_code: true,
            conditionals: true,
            booleans: true,
            unused: true,
            if_return: true,
            join_vars: true,
        }
    };
};

/**
 * Main bundling execution function.
 *
 * This function orchestrates the creation of JavaScript bundles for Magento 2.
 * It iterates over deployed locales, resolves module paths (handling requirejs-map.js),
 * concatenates module contents, applies aggressive minification (Terser),
 * and writes the final artifacts to the file system.
 *
 * Architecture Note:
 * Uses strictly sequential `for...of` loops to handle async operations safely
 * and prevent file system race conditions or memory spikes.
 *
 * @param {string} bundlingConfigPath - Path to the `magepack.config.js` file generated previously.
 * @param {string} [localesGlobPattern] - Optional Glob pattern to filter specific locales/themes.
 * @param {boolean} [includeSourcemaps=false] - Whether to generate source maps for debugging.
 * @param {boolean} [forceMinify=false] - Force usage of Terser even if Magento minification is off.
 * @param {string} [minifyStrategy='safe'] - 'aggressive' or 'safe'
 * @returns {Promise<void>} Resolves when all bundles have been written to disk.
 */
export default async (
    bundlingConfigPath,
    localesGlobPattern,
    includeSourcemaps = false,
    forceMinify = false,
    minifyStrategy = 'safe'
) => {
    const bundlingConfigRealPath = path.resolve(bundlingConfigPath);

    logger.info(`Using bundling config from "${bundlingConfigRealPath}".`);

    // Dynamic import to load the JS configuration file (supports ESM and CJS).
    const bundlingConfigModule = await import(bundlingConfigRealPath);
    // Handle both default export (ESM) and module.exports (CJS)
    const bundlingConfig = bundlingConfigModule.default || bundlingConfigModule;

    // Retrieve the list of deployed locales (excluding Magento/blank).
    const localesPaths = getLocales(localesGlobPattern);
    
    // Detect if Magento's static content is already minified (e.g. production mode).
    const isMinifyOn = checkMinifyOn(localesPaths);

    // --- ITERATION: Locales ---
    // We use a for...of loop to process locales sequentially.
    for (const localePath of localesPaths) {
        logger.info(`Creating bundles for "${localePath}".`);

        // Initialize the path mapper (handles requirejs-map.js versioning/substitution).
        const pathMapper = modulePathMapper(localePath, isMinifyOn);

        // --- ITERATION: Bundles (cms, category, product, etc.) ---
        for (const bundle of bundlingConfig) {
            const bundleName = bundle.name;
            logger.debug(`Processing bundle "${bundleName}"...`);

            // Resolve the destination path for the bundle file.
            const bundlePath = pathResolver.getBundlePath(
                localePath,
                bundleName,
                isMinifyOn
            );

            const bundleFileName = path.basename(bundlePath);
            const bundlePathDir = path.dirname(bundlePath);

            // Ensure destination directory exists.
            if (!fs.existsSync(bundlePathDir)) {
                fs.mkdirSync(bundlePathDir, { recursive: true });
            }

            let bundleContents = '';
            const bundledModules = [];
            const sourceMapRanges = [];
            const sourceRange = { start: 0, end: 0 };

            logger.debug(`Collecting modules for "${bundleName}".`);

            // --- ITERATION: Modules ---
            for (const [moduleName, moduleEntry] of Object.entries(bundle.modules)) {
                // Resolve the real file system path for the module.
                // This accounts for .min.js extensions and mapped paths.
                const rawModulePath = pathResolver.getModuleRealPath(
                    moduleName,
                    moduleEntry,
                    isMinifyOn
                );
                const modulePath = pathMapper(rawModulePath);

                logger.debug(`Loading "${moduleName}" from "${modulePath}".`);

                try {
                    let content = fs.readFileSync(modulePath, { encoding: 'utf8' });

                    // AST Analysis & Wrapping:
                    // We must wrap certain modules (Text, Non-AMD, Anonymous AMD)
                    // so they can be safely concatenated into a single RequireJS bundle.
                    if (moduleWrapper.isText(modulePath)) {
                        content = moduleWrapper.wrapText(moduleName, content);
                    } else if (moduleWrapper.isNonAmd(content)) {
                        content = moduleWrapper.wrapNonAmd(moduleName, content);
                    } else if (moduleWrapper.isAnonymousAmd(content)) {
                        content = moduleWrapper.wrapAnonymousAmd(moduleName, content);
                    }

                    // Track lines for SourceMap generation
                    const lines = content.split('\n').length;
                    sourceRange.end = sourceRange.start + lines;
                    
                    bundleContents += content + '\n';
                    bundledModules.push(moduleName);
                    
                    sourceMapRanges.push({
                        sourceFile: path.relative(bundlePathDir, modulePath),
                        start: sourceRange.start,
                        end: sourceRange.end,
                    });
                    
                    sourceRange.start = sourceRange.end;
                } catch (error) {
                    // It is common for some dynamic modules to be missing statically.
                    // We log debug info but continue bundling.
                    logger.debug(`Module "${moduleName}" skipped (not found at "${modulePath}").`);
                }
            }

            logger.debug(`Bundle "${bundleName}" collected. Preparing output...`);

            // Initialize SourceMap generator
            const sourceMap = genSourceMap(bundleFileName);
            sourceMap.addRanges(sourceMapRanges);

            // --- MINIFICATION (Terser) ---
            // Apply if Magento is in production mode OR if explicitly forced via CLI.
            if (isMinifyOn || forceMinify) {
                logger.debug(`Minifying "${bundleName}" with aggressive Terser config.`);

                /**
                 * Aggressive Terser Configuration.
                 * Optimized for mobile performance (size reduction) and Magento compatibility.
                 * @type {import('terser').MinifyOptions}
                 */
                const terserConfig = getTerserConfig(minifyStrategy, includeSourcemaps, bundleFileName, sourceMap);

                try {
                    const result = await terser.minify(bundleContents, terserConfig);
                    
                    if (result.error) {
                        throw result.error;
                    }

                    bundleContents = result.code;
                    
                    if (includeSourcemaps && result.map) {
                        fs.writeFileSync(`${bundlePath}.map`, result.map);
                    }
                    
                    logger.debug(`Minification successful.`);
                } catch (err) {
                    logger.error(`Minification failed for "${bundleName}": ${err.message}`);
                    // Fallback: Write unminified content to avoid breaking the site
                }
            } else if (includeSourcemaps) {
                // Append source map link for unminified dev mode
                bundleContents += `\n//# sourceMappingURL=${bundleFileName}.map\n`;
                fs.writeFileSync(`${bundlePath}.map`, sourceMap.getMap());
            }

            // --- WRITE TO DISK ---
            logger.debug(`Writing "${bundleName}" to disk.`);
            fs.writeFileSync(bundlePath, bundleContents);

            // Generate the RequireJS configuration chunk for this bundle.
            const bundleOptions = {
                bundles: {
                    [`magepack/bundle-${bundleName}`]: bundledModules,
                },
            };

            const bundleConfigPath = pathResolver.getBundleConfigPath(
                localePath,
                bundleName,
                isMinifyOn
            );

            // Ensure config directory exists
            const bundleConfigPathDir = path.dirname(bundleConfigPath);
            if (!fs.existsSync(bundleConfigPathDir)) {
                fs.mkdirSync(bundleConfigPathDir, { recursive: true });
            }

            fs.writeFileSync(
                bundleConfigPath,
                `requirejs.config(${stringify(bundleOptions)});`
            );

            // --- STATS LOGGING ---
            const bundleSize = Math.round(bundleContents.length / 1024) + ' kB';
            const gzipedSize = Math.round(gzipSizeSync(bundleContents) / 1024) + ' kB';

            logger.success(
                `Generated bundle "${bundleName}"`.padEnd(30) +
                `- ${bundleSize} (${gzipedSize} gz).`
            );
        }
    }
};
