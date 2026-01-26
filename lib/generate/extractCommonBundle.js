import merge from 'lodash.merge';

/**
 * Extracts common modules from all bundles into a 'common' bundle.
 */
const extractCommonBundle = (bundles) => {
    const commonModules = {};
    const moduleCounts = {};

    // Count occurrences of each module across bundles
    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((moduleName) => {
            if (!moduleCounts[moduleName]) {
                moduleCounts[moduleName] = 0;
            }
            moduleCounts[moduleName]++;
        });
    });

    const bundleCount = bundles.length;
    // Identify common modules (present in all bundles)
    Object.keys(moduleCounts).forEach((moduleName) => {
        if (moduleCounts[moduleName] === bundleCount) {
            // Take the path from the first bundle (assuming paths are consistent)
            commonModules[moduleName] = bundles[0].modules[moduleName];
        }
    });

    // Remove common modules from specific bundles
    bundles.forEach((bundle) => {
        Object.keys(commonModules).forEach((moduleName) => {
            delete bundle.modules[moduleName];
        });
    });

    // Add common bundle to the list
    bundles.unshift({
        name: 'common',
        modules: commonModules,
    });

    return bundles;
};

export default extractCommonBundle;
