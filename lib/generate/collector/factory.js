import merge from 'lodash.merge';
import logger from '../../utils/logger.js';
import collectModules from '../collectModules.js';
import configurePage from '../configurePage.js';

/**
 * Creates a standardized collector function for a specific page type.
 *
 * @param {string} bundleName - The name of the bundle (e.g., 'cms', 'category').
 * @param {string} urlConfigKey - The key in the config object holding the target URL (e.g., 'cmsUrl').
 * @returns {Function} An async collector function.
 */
export const createPageCollector = (bundleName, urlConfigKey) => {
    return async (browserContext, config) => {
        const bundleConfig = {
            url: '',
            name: bundleName,
            modules: {},
        };

        logger.info(`Collecting modules for bundle "${bundleName}".`);

        // Initialize the page using the centralized factory.
        const page = await configurePage(browserContext, config);

        try {
            const targetUrl = config[urlConfigKey];
            
            if (!targetUrl) {
                throw new Error(`Missing URL configuration for bundle "${bundleName}". Expected config.${urlConfigKey}.`);
            }

            // Update bundle config with the actual URL being visited
            bundleConfig.url = targetUrl;

            // Navigate to the target URL.
            await page.goto(targetUrl, { 
                waitUntil: 'networkidle0',
                timeout: config.timeout 
            });

            // Extract the modules loaded by RequireJS.
            const collectedModules = await collectModules(page);
            merge(bundleConfig.modules, collectedModules);

        } catch (error) {
            // Specialized Error Handling for "Dirty" Environments
            if (page.magepackDirty) {
                logger.error(`\n\n❌ CRITICAL ERROR: YOUR SITE IS TRYING TO LOAD OLD BUNDLES!`);
                logger.error(`The page "${config[urlConfigKey]}" requested 'magepack/bundle-*' files.`);
                logger.error(`This caused a deadlock because Magepack blocked them to prevent pollution.`);
                logger.error(`👉 ACTION REQUIRED: Run the following commands to clean up before generating:\n`);
                logger.error(`   rm -rf pub/static/frontend/* var/view_preprocessed/*`);
                logger.error(`   bin/magento setup:static-content:deploy fr_FR -f\n`);
                
                throw new Error("Generation stopped due to dirty environment (existing bundles detected).");
            }
            
            logger.error(`Error collecting modules for "${bundleName}": ${error.message}`);
            throw error;
        } finally {
            // Always close the page to free up memory
            await page.close();
        }

        logger.success(`Finished collecting modules for bundle "${bundleName}".`);

        return bundleConfig;
    };
};
