import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { createGzip, createBrotliCompress, constants } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { minify } from 'terser';
import consola from 'consola';

import moduleWrapper from './bundle/moduleWrapper.js';
// On importe la factory pour la Map RequireJS
import createPathResolver from './bundle/moduleMapResolver.js';
// On importe l'utilitaire de résolution de chemin physique
import { getModuleRealPath } from './bundle/pathResolver.js';
import getLocales from './bundle/getLocales.js';
import checkMinifyOn from './bundle/checkMinifyOn.js';

/**
 * Validates the generated configuration structure before processing.
 *
 * @param {Array<Object>} config - The bundling configuration array loaded from magepack.config.js.
 * @throws {Error} Throws an error if the configuration is not a valid array.
 */
const validateConfig = (config) => {
    if (!Array.isArray(config)) {
        throw new Error('Magepack config should be an array of bundle definitions.');
    }
};

/**
 * Compresses a file using Gzip and Brotli algorithms in parallel to maximize I/O throughput.
 *
 * @param {string} filePath - The absolute path to the source file.
 * @returns {Promise<void>} A promise that resolves when both compression streams are finished.
 */
const compressFile = async (filePath) => {
    const source = createReadStream(filePath);

    // Gzip Compression (Standard compatibility)
    const gzipTask = pipeline(
        source,
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );

    // Brotli Compression (Modern performance)
    const brotliSource = createReadStream(filePath);
    const brotliTask = pipeline(
        brotliSource,
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, // Quality 11
                [constants.BROTLI_PARAM_LGWIN]: 24, // Window size optimized for static assets
            },
        }),
        createWriteStream(`${filePath}.br`)
    );

    await Promise.all([gzipTask, brotliTask]);
};

/**
 * Processes a single bundle: resolves paths, concatenates modules, minifies code, writes to disk, and compresses.
 *
 * @param {Object} bundle - The bundle definition object (name, modules).
 * @param {string} localePath - The path to the static content directory for the current locale.
 * @param {Object} options - CLI options (minify, strategy, etc.).
 * @returns {Promise<void>}
 */
const processBundle = async (bundle, localePath, options) => {
    const bundleFilename = `bundle-${bundle.name}.js`;
    const destPath = path.join(localePath, 'js', 'magepack', bundleFilename);
    
    // 1. Détection de l'environnement source (Dev ou Prod/Minified)
    const isInputMinified = checkMinifyOn([localePath]);

    // 2. Initialisation du résolveur de Map (pour gérer le versioning Magento)
    const resolveMapPath = createPathResolver(localePath, isInputMinified);

    let bundleContent = '';
    const moduleNames = Object.keys(bundle.modules);

    for (const moduleName of moduleNames) {
        const modulePath = bundle.modules[moduleName];
        try {
            // A. Résolution via requirejs-map.js (versioning)
            const mappedPath = resolveMapPath(modulePath);

            // B. Résolution du chemin physique théorique
            const rawPath = getModuleRealPath(moduleName, mappedPath, isInputMinified);
            
            // C. Logique de tentative (Retry Logic) pour trouver le fichier réel
            // Ceci corrige le bug des modules avec des points (jquery.cookie, lazyload.min)
            // où l'extension .js n'était pas ajoutée.
            let absolutePath = null;
            
            // Liste des chemins candidats à tester
            const candidates = [rawPath];
            if (!rawPath.endsWith('.js')) {
                candidates.push(rawPath + '.js');
                // Si l'entrée est supposée minifiée, on teste aussi .min.js explicitement
                if (isInputMinified) {
                    candidates.push(rawPath + '.min.js');
                }
            }

            // On teste chaque candidat jusqu'à en trouver un qui existe
            for (const candidate of candidates) {
                try {
                    await fs.access(candidate);
                    absolutePath = candidate;
                    break; 
                } catch (e) {
                    // Continue to next candidate
                }
            }

            if (!absolutePath) {
                throw new Error(`ENOENT: File not found. Tried: ${candidates.join(', ')}`);
            }

            const content = await fs.readFile(absolutePath, 'utf-8');
            // Wrap raw content to ensure AMD compliance if necessary
            bundleContent += moduleWrapper(moduleName, content) + '\n';

        } catch (e) {
            // On affiche le chemin original pour aider au débogage
            consola.warn(`Skipping module ${moduleName} (Path: ${modulePath}) in bundle ${bundle.name}: ${e.message}`);
        }
    }

    // 3. Minify Content (Output)
    let finalContent = bundleContent;
    
    // Options CLI pour la minification de sortie
    const isAggressive = options.minifyStrategy === 'aggressive';
    const shouldMinifyOutput = options.minify || isAggressive;

    if (shouldMinifyOutput) {
        try {
            const result = await minify(bundleContent, {
                ecma: 2017, // Optimize for modern browsers
                toplevel: true, // Mangling of top-level variables
                compress: {
                    drop_console: isAggressive,     // Remove console.log calls only in aggressive mode
                    drop_debugger: true,            // Remove debugger statements
                    passes: 2,                      // Run compression twice
                    pure_funcs: isAggressive ? ['console.info', 'console.debug', 'console.warn'] : []
                },
                mangle: {
                    // Protect critical Magento and RequireJS global variables
                    reserved: ['mage', 'varien', 'require', 'define', 'ko', 'observable']
                }
            });

            if (result.code) {
                finalContent = result.code;
            } else if (result.error) {
                throw result.error;
            }
        } catch (minifyError) {
            consola.error(`Minification failed for bundle ${bundle.name}. Falling back to unminified content.`, minifyError);
        }
    }

    // 4. Write file to disk
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, finalContent);

    // 5. Generate compressed versions (.gz, .br)
    await compressFile(destPath);
};

/**
 * Generates the requirejs configuration file (requirejs-config-common.js).
 *
 * This function handles the wiring of the new 3-layer architecture.
 * It ensures that 'vendor' and 'common' bundles are loaded immediately as dependencies.
 *
 * @param {Array<Object>} bundles - List of processed bundles.
 * @param {string} localePath - Path to the locale directory.
 * @returns {Promise<void>}
 */
const generateRequireConfig = async (bundles, localePath) => {
    // We output to 'requirejs-config-common.js' to match the default XML layout configuration
    const configPath = path.join(localePath, 'js', 'magepack', 'requirejs-config-common.js');
    
    // 1. Build the 'bundles' map
    const bundlesConfig = {};
    bundles.forEach((bundle) => {
        const bundleName = `magepack/bundle-${bundle.name}`;
        bundlesConfig[bundleName] = Object.keys(bundle.modules);
    });

    // 2. Define Preload Dependencies ('deps')
    const deps = [];
    
    // CRITICAL: Order matters for execution stability.
    if (bundles.some(b => b.name === 'vendor')) {
        deps.push('magepack/bundle-vendor');
    }
    
    if (bundles.some(b => b.name === 'common')) {
        deps.push('magepack/bundle-common');
    }

    // 3. Generate content
    const configContent = `
/**
 * Magepack RequireJS Configuration.
 * Auto-generated by Magepack.
 *
 * This file maps modules to their respective bundles and enforces
 * the loading priority of the Vendor and Common layers.
 */
require.config({
    deps: ${JSON.stringify(deps)},
    bundles: ${JSON.stringify(bundlesConfig)}
});
`;

    await fs.writeFile(configPath, configContent);
};

/**
 * Main entry point for the bundling process.
 * Orchestrates the processing of locales and bundles.
 *
 * @param {string} configPath - Path to the config file (e.g. magepack.config.js).
 * @param {string} globPattern - Glob pattern for locales.
 * @param {boolean} sourcemap - Whether to generate sourcemaps.
 * @param {boolean} minifyFlag - Whether to force minification.
 * @param {string} minifyStrategy - 'safe' or 'aggressive'.
 */
export default async (configPath, globPattern, sourcemap, minifyFlag, minifyStrategy) => {
    // 1. Load Configuration File
    const require = createRequire(import.meta.url);
    let config;
    try {
        const absoluteConfigPath = path.resolve(process.cwd(), configPath);
        config = require(absoluteConfigPath);
    } catch (e) {
        throw new Error(`Could not load configuration file at ${configPath}. Error: ${e.message}`);
    }

    // 2. Validate Configuration
    validateConfig(config);

    // 3. Prepare Options
    const options = {
        glob: globPattern,
        sourcemap: sourcemap,
        minify: minifyFlag,
        minifyStrategy: minifyStrategy
    };

    const locales = await getLocales(process.cwd());
    const localesPaths = locales.map((locale) =>
        path.join(process.cwd(), 'pub', 'static', 'frontend', locale.vendor, locale.name, locale.code)
    );

    consola.info(`Found ${locales.length} locales to process.`);
    const startTime = process.hrtime();

    // Iterate over each locale found in the static directory
    for (const localePath of localesPaths) {
        const localeName = path.basename(localePath);
        consola.start(`Bundling for locale: ${localeName}`);

        try {
            // 4. Process all bundles in parallel for this locale
            await Promise.all(
                config.map((bundle) => processBundle(bundle, localePath, options))
            );

            // 5. Generate the wiring configuration (requirejs-config-common.js)
            await generateRequireConfig(config, localePath);

            consola.success(`Bundling finished for ${localeName}`);
        } catch (e) {
            consola.error(`Failed to bundle locale ${localeName}: ${e.message}`);
        }
    }

    const [seconds] = process.hrtime(startTime);
    consola.success(`✨ Magepack bundling complete in ${seconds}s.`);
};
