import fs from 'node:fs/promises';
import path from 'node:path';
import consola from 'consola';
import { minify } from 'terser';

import moduleWrapper from './moduleWrapper.js';
import createPathResolver from './moduleMapResolver.js';
import { buildTerserOptions } from './config/terserOptions.js';
import { compressFile } from './service/compressor.js';
import { reportBundleSize } from './service/reporter.js';

/**
 * List of sensitive module patterns that require safe minification.
 * These are typically payment gateways or older libraries that rely on function names or strict evaluation.
 * @type {RegExp[]}
 */
const SENSITIVE_PATTERNS = [
    /paypal/i,
    /braintree/i,
    /adyen/i,
    /stripe/i,
    /amazon/i
];

/**
 * Resolves a module file on disk with fail-over for minified versions.
 * * @param {string} rootDir - Absolute path to the locale directory.
 * @param {string} moduleName - The RequireJS module ID.
 * @param {string} modulePath - The resolved mapped path.
 * @param {boolean} isMinifyOn - Whether Magento minification is enabled.
 * @returns {Promise<string>} The absolute path to the file.
 * @throws {Error} If the file cannot be found.
 */
const resolveFile = async (rootDir, moduleName, modulePath, isMinifyOn) => {
    const fullPath = path.resolve(rootDir, modulePath);
    
    // 1. Static resources (HTML, CSS, JSON) are returned as-is.
    const isStatic = moduleName.startsWith('text!') || 
                     moduleName.startsWith('domReady!') || 
                     /\.(html|json|css|txt|svg)$/i.test(fullPath);

    if (isStatic) {
        await fs.access(fullPath);
        return fullPath;
    }

    // 2. JavaScript Resolution (Try .min.js then .js, or vice-versa)
    const basePath = fullPath.endsWith('.js') ? fullPath.slice(0, -3) : fullPath;
    const minifiedPath = `${basePath}.min.js`;
    const standardPath = `${basePath}.js`;

    const primaryPath = isMinifyOn ? minifiedPath : standardPath;
    const fallbackPath = isMinifyOn ? standardPath : minifiedPath;

    try {
        await fs.access(primaryPath);
        return primaryPath;
    } catch {
        // Retry with fallback
        await fs.access(fallbackPath);
        return fallbackPath;
    }
};

/**
 * Determines if a bundle contains sensitive modules requiring a safe strategy.
 * * @param {string[]} moduleNames - List of modules in the bundle.
 * @returns {boolean} True if sensitive.
 */
const hasSensitiveModules = (moduleNames) => {
    return moduleNames.some(name => SENSITIVE_PATTERNS.some(pattern => pattern.test(name)));
};

/**
 * Process a single bundle: Read -> Wrap -> Minify -> Write -> Compress.
 * Implements the "Pipeline" pattern.
 *
 * @param {{name: string, modules: Record<string, string>}} bundle - The bundle definition.
 * @param {string} localePath - Absolute path to the locale directory.
 * @param {{minify?: boolean, minifyStrategy?: 'safe'|'aggressive', sourcemap?: boolean}} options - CLI options.
 * @param {boolean} isMinifyOn - Whether to target minified filenames.
 * @returns {Promise<void>}
 */
export const processBundle = async (bundle, localePath, options, isMinifyOn) => {
    const outputExt = isMinifyOn ? '.min.js' : '.js';
    const bundleFilename = `bundle-${bundle.name}${outputExt}`;
    const destPath = path.join(localePath, 'magepack', bundleFilename);
    
    const resolveMap = createPathResolver(localePath, isMinifyOn);
    const moduleNames = Object.keys(bundle.modules || {});
    
    /** @type {Record<string, string>} */
    const sources = {};
    let successCount = 0;

    // --- STEP 1: Collection & Wrapping ---
    for (const moduleName of moduleNames) {
        try {
            const rawModulePath = bundle.modules[moduleName];
            const mappedPath = resolveMap(rawModulePath);
            const absPath = await resolveFile(localePath, moduleName, mappedPath, isMinifyOn);
            
            const content = await fs.readFile(absPath, 'utf8');
            
            // Wrap the raw content in define() if needed
            sources[moduleName] = moduleWrapper(moduleName, content, absPath);
            successCount++;
        } catch (e) {
            // FAIL-SOFT: Log warning but do not crash the build.
            consola.warn(`⚠️  Skipping module "${moduleName}" in ${bundle.name}: File not found.`);
        }
    }

    if (successCount === 0) {
        consola.warn(`⚠️  Empty bundle ${bundleFilename} - Skipping write.`);
        return;
    }

    // --- STEP 2: Minification Strategy ---
    let finalContent = '';
    
    // Safety Override: Check for payment scripts
    const containsSensitive = hasSensitiveModules(moduleNames);
    const requestedStrategy = options.minifyStrategy || 'safe';
    const effectiveStrategy = containsSensitive ? 'safe' : requestedStrategy;
    
    if (containsSensitive && requestedStrategy === 'aggressive') {
        consola.info(`   🛡️  Switched ${bundle.name} to SAFE mode (sensitive modules detected).`);
    }

    const shouldMinifyContent = Boolean(options.minify) || effectiveStrategy === 'aggressive';
    const shouldGenerateSourceMap = Boolean(options.sourcemap);

    // --- STEP 3: Transformation (Terser) ---
    if (shouldMinifyContent || shouldGenerateSourceMap) {
        try {
            const terserOptions = buildTerserOptions(effectiveStrategy, shouldGenerateSourceMap, bundleFilename);

            if (!shouldMinifyContent) {
                // If only sourcemap is requested without minification
                terserOptions.compress = false;
                terserOptions.mangle = false;
                terserOptions.format = { beautify: true };
            }

            const result = await minify(sources, terserOptions);
            
            if (result?.code) {
                finalContent = result.code;
                
                if (shouldGenerateSourceMap && result.map) {
                    await fs.writeFile(`${destPath}.map`, result.map, 'utf8');
                }
            }
        } catch (err) {
            consola.error(`❌ Terser crashed on ${bundle.name}. Falling back to raw concatenation. Error: ${err.message}`);
            finalContent = Object.values(sources).join('\n');
        }
    } else {
        // Fast path: Just join strings
        finalContent = Object.values(sources).join('\n');
    }

    // --- STEP 4: Output & Compression ---
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, finalContent, 'utf8');
    
    // Parallel compression (Gzip + Brotli)
    await compressFile(destPath);
    await reportBundleSize(destPath);
};
