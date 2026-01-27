import merge from 'lodash.merge';
import logger from '../../utils/logger.js';
import collectModules from '../collectModules.js';
import configurePage from '../configurePage.js';

/**
 * Configuration template for the Category bundle.
 * @type {Object}
 */
const baseConfig = {
    url: '',
    name: 'category',
    modules: {},
};

/**
 * Collects RequireJS modules from a specific Category page (PLP).
 *
 * This function orchestrates the collection process for the category page type.
 * It leverages the centralized page configuration to ensure consistent timeouts
 * and mobile viewport settings.
 *
 * @param {import('puppeteer').BrowserContext} browserContext - The browser context instance.
 * @param {Object} config - The generation configuration object.
 * @param {string} config.categoryUrl - The target URL for the Category page.
 * @param {number} config.timeout - Global timeout in milliseconds.
 * @param {string} [config.authUsername] - HTTP Basic Auth username.
 * @param {string} [config.authPassword] - HTTP Basic Auth password.
 * @returns {Promise<Object>} The bundle configuration object containing collected modules.
 */
const category = async (browserContext, config) => {
    const bundleConfig = merge({}, baseConfig);
    const bundleName = bundleConfig.name;

    logger.info(`Collecting modules for bundle "${bundleName}".`);

    // Initialize the page using the centralized factory.
    // Explicitly handles viewport, auth, and timeouts.
    const page = await configurePage(browserContext, config);

    try {
        // Navigate to the Category URL.
        // We rely on 'networkidle0' to capture lazy-loaded components common on PLPs.
        await page.goto(config.categoryUrl, { 
            waitUntil: 'networkidle0',
            timeout: config.timeout 
        });

        // Extract the modules loaded by RequireJS.
        const collectedModules = await collectModules(page);
        merge(bundleConfig.modules, collectedModules);

    } catch (error) {
        logger.error(`Error collecting modules for "${bundleName}": ${error.message}`);
        throw error;
    } finally {
        // Ensure resources are released.
        await page.close();
    }

    logger.success(`Finished collecting modules for bundle "${bundleName}".`);

    return bundleConfig;
};

export default category;
