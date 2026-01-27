import authenticate from './authenticate.js';
import blockMagepack from './blockMagepack.js';

/**
 * Configures and initializes a new Puppeteer page instance with standardized settings.
 *
 * This factory function ensures that every page used by the collectors adheres to
 * the global configuration, including:
 * - Strict timeouts for navigation and selectors.
 * - Blocking of existing Magepack bundles to prevent double-bundling pollution.
 * - HTTP Basic Authentication (if credentials are provided).
 *
 * @param {import('puppeteer').BrowserContext} browserContext - The isolated browser context to create the page in.
 * @param {Object} config - The generation configuration object.
 * @param {string|number} config.timeout - Global timeout in milliseconds.
 * @param {string} [config.authUsername] - HTTP Basic Auth username.
 * @param {string} [config.authPassword] - HTTP Basic Auth password.
 * @returns {Promise<import('puppeteer').Page>} A promise that resolves to the fully configured Puppeteer Page instance.
 */
export default async (browserContext, config) => {
    const page = await browserContext.newPage();

    // --- MAGEPACK EVOLUTION: Execution Order Capture ---
    // We inject a script before the page loads to hook into RequireJS.
    // This allows us to record the EXACT order in which modules are fully resolved and loaded.
    await page.evaluateOnNewDocument(() => {
        window.__magepackOrderedModules = [];
        let rjs;
        
        // We define a setter for the global 'requirejs' variable.
        // This catches the moment require.js is loaded by the browser.
        Object.defineProperty(window, 'requirejs', {
            get() { return rjs; },
            set(val) {
                rjs = val;
                // Once RequireJS is present, we wrap its internal 'onResourceLoad' method.
                if (rjs && !rjs._hooked) {
                    rjs._hooked = true;
                    const original = rjs.onResourceLoad;
                    
                    rjs.onResourceLoad = function (context, map, depArray) {
                        // 'map.name' is the module ID (e.g., 'jquery', 'Magento_Ui/js/modal/modal').
                        // We push it to our array immediately upon load completion.
                        if (map.name) {
                            window.__magepackOrderedModules.push(map.name);
                        }
                        // Always call the original method to not break functionality.
                        if (original) original.apply(this, arguments);
                    };
                }
            },
            configurable: true
        });
    });
    // ---------------------------------------------------

    // Set strict default timeouts for all subsequent operations on this page.
    // This overrides the Puppeteer default (usually 30s) with the user-provided value.
    page.setDefaultTimeout(config.timeout);
    page.setDefaultNavigationTimeout(config.timeout);

    // Prevent infinite loops or pollution by blocking requests to existing Magepack bundles.
    await blockMagepack(page);

    // Perform authentication if credentials are provided in the config.
    await authenticate(page, config.authUsername, config.authPassword);

    return page;
};
