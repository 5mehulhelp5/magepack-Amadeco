/**
 * @file lib/generate/extractCommonBundle.js
 * @description Splits modules into Vendor, Common, and Page-Specific bundles ensuring strict exclusivity.
 */

/**
 * ============================================================================
 * CONSTANTS & CONFIGURATION
 * ============================================================================
 */


/**
 * MIN_USAGE_THRESHOLD
 * Determines the promotion strategy for shared modules.
 *
 * @type {number}
 * @default 2
 *
 * Strategy:
 * - 2: Balanced. If a module is used on >= 2 page types (e.g., Home + Product),
 * it moves to 'common'.
 */
const MIN_USAGE_THRESHOLD = 2;

/**
 * MANUAL_COMMON_MODULES
 * List of modules that are explicitly forced into the 'common' bundle,
 * regardless of their usage count.
 * Useful for business logic that you always want available.
 *
 * @type {string[]}
 */
const MANUAL_COMMON_MODULES = [];

/**
 * CRITICAL_EXACT_MODULES (Vendor Forced)
 * List of critical module paths (exact match) that MUST be included in the Vendor bundle.
 * These files are requested early and must be present to prevent 404/MIME errors.
 */
const CRITICAL_EXACT_MODULES = [
    'Magento_PageCache/js/form-key-provider',
    'Magento_Theme/js/responsive',
    'Magento_Theme/js/theme',
    'Magento_Translation/js/mage-translation-dictionary',
    'Magento_Ui/js/core/app',
    'Magento_Ui/js/modal/modal'
];

/**
 * CRITICAL_PATTERN_MODULES (Vendor Forced via Regex)
 * Regular expressions identifying Core Infrastructure modules (Kernel).
 */
const CRITICAL_PATTERN_MODULES = [
    /^mage\/(?!calendar|gallery)/, // Magento Core Libs (excluding heavy UI)
    /^requirejs\//,                // RequireJS internals
    /^text$/,                      // RequireJS Text Plugin
    /^domReady$/,                  // RequireJS DomReady Plugin
    /^jquery\/jquery(\.min)?\.js$/,// jQuery Core
    /^jquery\/jquery-migrate/,     // jQuery Migrate
    /^jquery\/jquery-storageapi/,  // jQuery Storage
    /^underscore$/,                // Underscore.js
    /^knockoutjs\/knockout$/       // Knockout JS
];

/**
 * MAGENTO_MODULE_REGEX
 * Identifies standard Magento 2 module naming convention (Vendor_Module).
 * Used to distinguish "Business Logic" (Common) from "Libraries" (Vendor).
 */
const MAGENTO_MODULE_REGEX = /^[A-Z][a-zA-Z0-9]+_[A-Z][a-zA-Z0-9]+\//;

/**
 * ============================================================================
 * HELPER FUNCTIONS
 * ============================================================================
 */

/**
 * Normalizes a RequireJS module name.
 * @param {string} moduleName
 * @returns {string} Cleaned name
 */
const cleanModuleName = (moduleName) => {
    return moduleName
        .replace(/^[^!]+!/, '') // Remove plugins
        .replace(/\.js$/, '');  // Remove extension
};

/**
 * Checks if a module is strictly required in the Vendor bundle.
 * @param {string} cleanName
 * @returns {boolean}
 */
const isCriticalInfrastructure = (cleanName) => {
    if (CRITICAL_EXACT_MODULES.has(cleanName)) return true;
    return CRITICAL_PATTERN_MODULES.some((pattern) => pattern.test(cleanName));
};

/**
 * Determines the destination bundle type.
 * @param {string} cleanName
 * @returns {'vendor'|'common'}
 */
const getTargetBundleType = (cleanName) => {
    if (/\.(html|json)$/i.test(cleanName)) return 'common';
    if (isCriticalInfrastructure(cleanName)) return 'vendor';
    if (MAGENTO_MODULE_REGEX.test(cleanName)) return 'common';
    return 'vendor';
};

/**
 * Checks if a module is explicitly configured as common.
 * @param {string} moduleName
 * @returns {boolean}
 */
const isExplicitlyCommon = (moduleName) => {
    return MANUAL_COMMON_MODULES.includes(cleanModuleName(moduleName));
};

/**
 * ============================================================================
 * MAIN LOGIC
 * ============================================================================
 */

/**
 * Extracts common and vendor modules from page bundles.
 * Implements strict exclusivity: A module exists in exactly one bundle.
 *
 * @param {Array<{name: string, modules: Object.<string, string>}>} bundles
 * @returns {Array<{name: string, modules: Object.<string, string>}>}
 */
export default function (bundles) {
    const vendorModules = new Map();
    const commonModules = new Map();
    const usageCounts = new Map();

    // 1. Global Analysis: Count usage of each module across all bundles
    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((moduleName) => {
            const currentCount = usageCounts.get(moduleName) || 0;
            usageCounts.set(moduleName, currentCount + 1);
        });
    });

    // 2. Classification & Routing (Strict Move)
    // We iterate over the original bundles and MOVE modules to Vendor/Common.
    bundles.forEach((bundle) => {
        // Use Object.keys to get a static list of keys before we start deleting them
        const bundleModuleNames = Object.keys(bundle.modules);

        bundleModuleNames.forEach((moduleName) => {
            const modulePath = bundle.modules[moduleName];
            const cleanName = cleanModuleName(moduleName);

            // Determine if the module needs to be moved
            const isForcedVendor = isCriticalInfrastructure(cleanName);
            const isShared = usageCounts.get(moduleName) >= MIN_USAGE_THRESHOLD;
            const isConfigured = isExplicitlyCommon(moduleName);

            let targetMap = null;

            if (isForcedVendor) {
                // Priority 1: Infrastructure goes to Vendor
                // Logic: If it's infrastructure, we force it to vendor even if used once,
                // BUT the logic `getTargetBundleType` handles the split between Common/Vendor
                // for shared items. Here we decide IF we extract it.
                // Actually, for vendor items, we ALWAYS extract them to be safe and available globally.
                targetMap = vendorModules;
            } else if (isShared || isConfigured) {
                // Priority 2: Shared logic
                const targetType = getTargetBundleType(cleanName);
                targetMap = targetType === 'vendor' ? vendorModules : commonModules;
            }

            // 3. Execution: Move and Delete
            if (targetMap) {
                // Add to target bundle
                targetMap.set(moduleName, modulePath);

                // CRITICAL FIX: Remove from the specific page bundle immediately.
                // This ensures the module is NOT present in two places.
                delete bundle.modules[moduleName];
            }
        });
    });

    // 4. Assembly
    // Note: The original 'bundles' objects are now mutated (stripped of moved modules).
    return [
        {
            name: 'vendor',
            modules: Object.fromEntries(vendorModules)
        },
        {
            name: 'common',
            modules: Object.fromEntries(commonModules)
        },
        ...bundles
    ];
}
