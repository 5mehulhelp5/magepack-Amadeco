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
    
    // --- MAGEPACK EVOLUTION: Preservation of Execution Order ---
    // Instead of iterating over 'moduleCounts' keys (which loses order),
    // we iterate over the modules of the FIRST bundle.
    // Since individual bundles are now sorted by execution order (thanks to our previous changes),
    // using the first bundle as a reference ensures 'bundle-common.js' respects dependency order.
    if (bundles.length > 0) {
        const referenceBundle = bundles[0];
        
        Object.keys(referenceBundle.modules).forEach((moduleName) => {
            // If the module is present in ALL bundles, it belongs in common.
            // By adding it now, we insert it into 'commonModules' in the correct dependency order.
            if (moduleCounts[moduleName] === bundleCount) {
                commonModules[moduleName] = referenceBundle.modules[moduleName];
            }
        });
    }
    // -----------------------------------------------------------

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
