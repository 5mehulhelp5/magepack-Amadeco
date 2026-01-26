import excludedModules from './excludedModules.js';

/**
 * Collects all defined RequireJS modules on a given page.
 */
const collectModules = async (page) => {
    // Wait to make sure RequireJS is loaded.
    await page.waitForFunction(() => window.require);

    // Use Magento's rjsResolver to wait for all modules to load.
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                require(['rjsResolver'], (resolver) => {
                    resolver(() => resolve());
                });
            })
    );

    // Wait for browser to be idle.
    await page.evaluate(
        () =>
            new Promise((resolve) => {
                requestIdleCallback(resolve);
            })
    );

    // Wait another 5s for good measure.
    await new Promise(r => setTimeout(r, 5000));

    const modules = await page.evaluate((excludedModules) => {
        function extractBaseUrl(require) {
            const baseUrl = require.toUrl('');
            return baseUrl.replace(/\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/$/, '/');
        }

        function stripBaseUrl(baseUrl, moduleUrl) {
            if (!moduleUrl.startsWith(baseUrl)) {
                return moduleUrl;
            }
            return moduleUrl
                .substring(baseUrl.length)
                .replace(/^[^/]+\/[^/]+\/[^/]+\/[^/]+\//, '');
        }

        const stripPlugin = (moduleName) => moduleName.replace(/^[^!].+!/, '');

        const baseUrl = extractBaseUrl(require);
        const unbundledContext = require.s.newContext('magepack');

        // Configure separate context to fetch real paths
        const defConfig = require.s.contexts._.config;
        unbundledContext.configure({
            baseUrl: defConfig.baseUrl,
            paths: defConfig.paths,
            shim: defConfig.shim,
            config: defConfig.config,
            map: defConfig.map,
        });

        const modules = {};
        Object.keys(window.require.s.contexts._.defined).forEach(
            (moduleName) => {
                // Ignore plugins (except text) and external URLs
                if (
                    (moduleName.includes('!') &&
                        !moduleName.startsWith('text!')) ||
                    moduleName.match(/^(https?:)?\/\//)
                ) {
                    return;
                }

                if (excludedModules.includes(moduleName)) {
                    return;
                }

                modules[moduleName] = stripBaseUrl(
                    baseUrl,
                    unbundledContext.require.toUrl(stripPlugin(moduleName))
                );
            }
        );

        return modules;
    }, excludedModules);

    return modules;
};

export default collectModules;
