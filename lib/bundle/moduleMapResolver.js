import path from 'node:path';
import fs from 'node:fs';

/**
 * Helper: Default path joiner
 */
const defaultModulePath = (themePath, modulePath) => {
    return path.join(themePath, modulePath);
};

/**
 * Helper: Resolve path using the baseUrlInterceptor map
 */
const mappedModulePath = (themePath, modulePath, map) => {
    // If the module exists in the map, inject the mapped prefix/path
    if (!map[modulePath]) {
        return defaultModulePath(themePath, modulePath);
    }

    return path.join(themePath, map[modulePath], modulePath);
};

/**
 * Returns a function that resolves a module path against a specific locale,
 * accounting for Magento's requirejs-map.js (used for versioning/cache-busting).
 *
 * @param {string} themePath Path to the theme locale (e.g. pub/static/frontend/...)
 * @param {boolean} isMinified Whether we are in minification mode
 * @returns {function(string): string}
 */
export default function (themePath, isMinified) {
    const bundleMapFile = path.join(
        themePath,
        'requirejs-map.' + (isMinified ? 'min.' : '') + 'js'
    );

    if (fs.existsSync(bundleMapFile)) {
        // We use new Function to simulate a 'require' environment.
        // Magento's map file typically contains: require.config({ ... });
        // We inject a mock 'require' object to intercept that configuration.
        const map = new Function(
            'require',
            'return ' + fs.readFileSync(bundleMapFile, 'utf8')
        )({
            config: (config) => {
                // We specifically look for the baseUrlInterceptor which holds the path mappings
                if (config.config && config.config.baseUrlInterceptor) {
                    return config.config.baseUrlInterceptor;
                }

                return {};
            },
            map: {},
        });

        return function (modulePath) {
            return mappedModulePath(themePath, modulePath, map);
        };
    }

    // Fallback if no map file exists
    return function (modulePath) {
        return defaultModulePath(themePath, modulePath);
    };
}
