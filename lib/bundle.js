import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { createGzip, createBrotliCompress, constants } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { minify } from 'terser';
import consola from 'consola';

import moduleWrapper from './bundle/moduleWrapper.js';
// IMPORT CORRECT : On a besoin des deux résolveurs (Map + Extension)
import createPathResolver from './bundle/moduleMapResolver.js';
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
 * Compresses a file using Gzip and Brotli algorithms in parallel.
 *
 * @param {string} filePath - The absolute path to the source file.
 * @returns {Promise<void>}
 */
const compressFile = async (filePath) => {
    const source = createReadStream(filePath);

    // Gzip Compression
    const gzipTask = pipeline(
        source,
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );

    // Brotli Compression
    const brotliSource = createReadStream(filePath);
    const brotliTask = pipeline(
        brotliSource,
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                [constants.BROTLI_PARAM_LGWIN]: 24,
            },
        }),
        createWriteStream(`${filePath}.br`)
    );

    await Promise.all([gzipTask, brotliTask]);
};

/**
 * Processes a single bundle.
 *
 * @param {Object} bundle - The bundle definition object.
 * @param {string} localePath - The path to the static content directory.
 * @param {Object} options - CLI options.
 * @returns {Promise<void>}
 */
const processBundle = async (bundle, localePath, options) => {
    const bundleFilename = `bundle-${bundle.name}.js`;
    const destPath = path.join(localePath, 'js', 'magepack', bundleFilename);
    
    // --- CORRECTION V2 : Détection de l'environnement source ---
    // On vérifie si les fichiers sources sur le disque sont minifiés (Mode Production Magento)
    // ou bruts (Mode Developer). On ne se base pas sur l'option CLI --minify ici.
    const isInputMinified = checkMinifyOn([localePath]);

    // 1. Initialisation du résolveur de Map (gestion des versions)
    const resolveMapPath = createPathResolver(localePath, isInputMinified);

    let bundleContent = '';
    const moduleNames = Object.keys(bundle.modules);

    for (const moduleName of moduleNames) {
        const modulePath = bundle.modules[moduleName];
        try {
            // Étape 1 : Résolution du chemin via la Map RequireJS (pour le versioning)
            // ex: 'mage/decorate' -> '/path/to/static/version123/mage/decorate'
            const mappedPath = resolveMapPath(modulePath);

            // Étape 2 : Ajout de l'extension correcte (.js ou .min.js)
            // ex: '/path/to/static/.../decorate' -> '/path/to/static/.../decorate.js'
            const absolutePath = getModuleRealPath(moduleName, mappedPath, isInputMinified);
            
            // Vérification physique
            await fs.access(absolutePath);

            const content = await fs.readFile(absolutePath, 'utf-8');
            bundleContent += moduleWrapper(moduleName, content) + '\n';
        } catch (e) {
            // Warning clair incluant le chemin tenté pour le débogage
            consola.warn(`Skipping module ${moduleName} (Path: ${bundle.modules[moduleName]}) in bundle ${bundle.name}: ${e.message}`);
        }
    }

    // 2. Minification du contenu (Output)
    let finalContent = bundleContent;
    
    // Ici, on utilise l'option CLI pour savoir si on doit compresser le RÉSULTAT final
    const isAggressive = options.minifyStrategy === 'aggressive';
    const shouldMinifyOutput = options.minify || isAggressive;

    if (shouldMinifyOutput) {
        try {
            const result = await minify(bundleContent, {
                ecma: 2017,
                toplevel: true,
                compress: {
                    drop_console: isAggressive,
                    drop_debugger: true,
                    passes: 2,
                    pure_funcs: isAggressive ? ['console.info', 'console.debug', 'console.warn'] : []
                },
                mangle: {
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

    // 3. Écriture sur le disque
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, finalContent);

    // 4. Compression (.gz, .br)
    await compressFile(destPath);
};

/**
 * Generates the requirejs configuration file.
 */
const generateRequireConfig = async (bundles, localePath) => {
    const configPath = path.join(localePath, 'js', 'magepack', 'requirejs-config-common.js');
    
    const bundlesConfig = {};
    bundles.forEach((bundle) => {
        const bundleName = `magepack/bundle-${bundle.name}`;
        bundlesConfig[bundleName] = Object.keys(bundle.modules);
    });

    const deps = [];
    if (bundles.some(b => b.name === 'vendor')) deps.push('magepack/bundle-vendor');
    if (bundles.some(b => b.name === 'common')) deps.push('magepack/bundle-common');

    const configContent = `
/**
 * Magepack RequireJS Configuration.
 * Auto-generated by Magepack.
 */
require.config({
    deps: ${JSON.stringify(deps)},
    bundles: ${JSON.stringify(bundlesConfig)}
});
`;

    await fs.writeFile(configPath, configContent);
};

/**
 * Main entry point.
 */
export default async (configPath, globPattern, sourcemap, minifyFlag, minifyStrategy) => {
    const require = createRequire(import.meta.url);
    let config;
    try {
        const absoluteConfigPath = path.resolve(process.cwd(), configPath);
        config = require(absoluteConfigPath);
    } catch (e) {
        throw new Error(`Could not load configuration file at ${configPath}. Error: ${e.message}`);
    }

    validateConfig(config);

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

    for (const localePath of localesPaths) {
        const localeName = path.basename(localePath);
        consola.start(`Bundling for locale: ${localeName}`);

        try {
            await Promise.all(
                config.map((bundle) => processBundle(bundle, localePath, options))
            );
            await generateRequireConfig(config, localePath);
            consola.success(`Bundling finished for ${localeName}`);
        } catch (e) {
            consola.error(`Failed to bundle locale ${localeName}: ${e.message}`);
        }
    }

    const [seconds] = process.hrtime(startTime);
    consola.success(`✨ Magepack bundling complete in ${seconds}s.`);
};
