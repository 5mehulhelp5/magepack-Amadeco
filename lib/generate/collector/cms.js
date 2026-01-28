import merge from 'lodash.merge';
import logger from '../../utils/logger.js';
import collectModules from '../collectModules.js';
import configurePage from '../configurePage.js';

/**
 * Configuration template for the CMS bundle.
 * @type {Object}
 */
const baseConfig = {
    url: '',
    name: 'cms',
    modules: {},
};

/**
 * Collects RequireJS modules from a specific CMS page (e.g., Homepage, About Us).
 *
 * This function orchestrates the collection process by:
 * 1. Initializing a configured Puppeteer page (with mobile viewport & timeouts).
 * 2. Navigating to the target CMS URL.
 * 3. Extracting loaded RequireJS modules via the browser context.
 *
 * @param {import('puppeteer').BrowserContext} browserContext - The browser context instance.
 * @param {Object} config - The generation configuration object.
 * @param {string} config.cmsUrl - The target URL for the CMS page.
 * @param {number} config.timeout - Global timeout in milliseconds.
 * @param {string} [config.authUsername] - HTTP Basic Auth username.
 * @param {string} [config.authPassword] - HTTP Basic Auth password.
 * @returns {Promise<Object>} The bundle configuration object containing collected modules.
 */
const cms = async (browserContext, config) => {
    const bundleConfig = merge({}, baseConfig);
    const bundleName = bundleConfig.name;

    logger.info(`Collecting modules for bundle "${bundleName}".`);

    // Initialize the page using the centralized factory.
    // This applies the global timeout, mobile viewport, and authentication settings.
    const page = await configurePage(browserContext, config);

    try {
        // Navigate to the CMS page.
        // We use 'networkidle0' to ensure all initial assets (JS/CSS) are fully loaded.
        // The timeout from the config is explicitly passed (although setDefaultTimeout handles it too).
        await page.goto(config.cmsUrl, { 
            waitUntil: 'networkidle0',
            timeout: config.timeout 
        });

        // Collect all RequireJS modules loaded on the page.
        const collectedModules = await collectModules(page);
        merge(bundleConfig.modules, collectedModules);

    } catch (error) {
        if (page.magepackDirty) {
            logger.error(`\n\n❌ CRITICAL ERROR: YOUR SITE IS TRYING TO LOAD OLD BUNDLES!`);
            logger.error(`The page "${config.categoryUrl}" requested 'magepack/bundle-*' files.`);
            logger.error(`This caused a deadlock because Magepack blocked them to prevent pollution.`);
            logger.error(`👉 ACTION REQUIRED: Run the following commands to clean up before generating:\n`);
            logger.error(`   rm -rf pub/static/frontend/* var/view_preprocessed/*`);
            logger.error(`   bin/magento setup:static-content:deploy fr_FR -f\n`);
            
            throw new Error("Generation stopped due to dirty environment (existing bundles detected).");
        }
        
        logger.error(`Error collecting modules for "${bundleName}": ${error.message}`);
        throw error;
    } finally {
        // Always close the page to free up memory, even if an error occurs.
        await page.close();
    }

    logger.success(`Finished collecting modules for bundle "${bundleName}".`);

    return bundleConfig;
};

export default cms;
