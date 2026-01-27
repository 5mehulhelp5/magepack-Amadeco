import merge from 'lodash.merge';

/**
 * Analyzes the module name to determine if it belongs to the "Vendor" bundle (Infrastructure/Stable)
 * or the "Common" bundle (Business Logic/Volatile), based on Magento 2 architectural conventions.
 *
 * This approach respects the SOLID Open/Closed principle: we don't modify a hardcoded list,
 * we rely on the naming structure (PSR-4) which is stable.
 *
 * @param {string} moduleName - The RequireJS module name (e.g., 'jquery', 'Magento_Catalog/js/product').
 * @returns {boolean} - Returns true if the module is infrastructure (Vendor), false if business logic (Common).
 */
const isVendorModule = (moduleName) => {
    // 0. Preliminary Cleanup: Remove loader plugins to analyze the real path
    // Example: 'text!My_Module/template.html' -> 'My_Module/template.html'
    const cleanName = moduleName.replace(/^[^!]+!/, '');

    // -----------------------------------------------------------
    // RULE 0: Data Files and Templates -> COMMON
    // -----------------------------------------------------------
    // HTML templates and JSON translations are content-dependent.
    // They change frequently (theme updates, typo fixes) and should not invalidate the Vendor cache.
    if (cleanName.match(/\.(html|json)$/i)) {
        return false;
    }

    // -----------------------------------------------------------
    // RULE 1: Magento Kernel (Low Level) -> VENDOR
    // -----------------------------------------------------------
    // The 'mage/' namespace contains the framework's low-level API (cookies, init, translation).
    if (cleanName.startsWith('mage/')) {
        return true;
    }

    // -----------------------------------------------------------
    // RULE 2: Magento UI Engine -> VENDOR (Partial)
    // -----------------------------------------------------------
    // Magento_Ui is hybrid. We separate the Engine from the Components.
    // - 'lib' & 'core': MVVM Engine (Stable) -> Vendor
    // - 'view', 'modal', 'grid': UI Components (Volatile) -> Common
    if (cleanName.startsWith('Magento_Ui/js/lib/') || cleanName.startsWith('Magento_Ui/js/core/')) {
        return true;
    }

    // -----------------------------------------------------------
    // RULE 3: Module Naming Convention (PSR-4) -> COMMON
    // -----------------------------------------------------------
    // A standard Magento module strictly follows: "Vendor_Module/...".
    // Regex: Uppercase, alphanumeric, Underscore, Uppercase, alphanumeric, Slash.
    // If matched, it's Business Logic (e.g., 'Amasty_Gdpr', 'Magento_Catalog').
    const isMagentoModulePattern = /^[A-Z][a-zA-Z0-9]+_[A-Z][a-zA-Z0-9]+\//.test(cleanName);

    if (isMagentoModulePattern) {
        return false;
    }

    // -----------------------------------------------------------
    // RULE 4: Everything else is a Library -> VENDOR
    // -----------------------------------------------------------
    // If it's not a PSR-4 module, it's a library (native or third-party).
    // Captures: 'jquery', 'knockout', 'underscore', 'npm-asset/...', 'tw-bootstrap/...'
    return true;
};

/**
 * Extracts common modules from all bundles and splits them into 'vendor' and 'common' bundles.
 *
 * It strictly preserves the Execution Order by using the first bundle as a topological reference.
 *
 * @param {Array<Object>} bundles - The list of collected bundles.
 * @returns {Array<Object>} - The modified bundles list with 'vendor' and 'common' prepended.
 */
const extractCommonBundle = (bundles) => {
    const vendorModules = {};
    const commonModules = {};
    const moduleCounts = {};

    // 1. Count occurrences of each module across all bundles
    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((moduleName) => {
            if (!moduleCounts[moduleName]) {
                moduleCounts[moduleName] = 0;
            }
            moduleCounts[moduleName]++;
        });
    });

    const bundleCount = bundles.length;

    // 2. Intelligent Split (Vendor vs Common) preserving Execution Order
    // We rely on the 'referenceBundle' (bundles[0]) because it is already sorted
    // by the browser's execution order (thanks to our previous 'collectModules.js' patch).
    if (bundles.length > 0) {
        const referenceBundle = bundles[0];

        Object.keys(referenceBundle.modules).forEach((moduleName) => {
            // A module is strictly "common" if it appears in ALL bundles
            if (moduleCounts[moduleName] === bundleCount) {
                const path = referenceBundle.modules[moduleName];

                // SPLIT LOGIC: Direct the module to the correct bucket based on architecture
                if (isVendorModule(moduleName)) {
                    vendorModules[moduleName] = path;
                } else {
                    commonModules[moduleName] = path;
                }
            }
        });
    }

    // 3. Cleanup: Remove shared modules from specific page bundles
    bundles.forEach((bundle) => {
        Object.keys(vendorModules).forEach((moduleName) => delete bundle.modules[moduleName]);
        Object.keys(commonModules).forEach((moduleName) => delete bundle.modules[moduleName]);
    });

    // 4. Injection: Add shared bundles to the beginning of the list.
    // The order determines the loading priority in RequireJS:
    // 1. VENDOR (Infrastructure)
    // 2. COMMON (Shared Business Logic)
    // 3. PAGE (Specific Logic)
    
    // Level 2: COMMON
    bundles.unshift({
        name: 'common',
        modules: commonModules,
    });

    // Level 1: VENDOR
    bundles.unshift({
        name: 'vendor',
        modules: vendorModules,
    });

    return bundles;
};

export default extractCommonBundle;
