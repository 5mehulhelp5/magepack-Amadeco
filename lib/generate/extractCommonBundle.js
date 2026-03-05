/**
 * @file lib/generate/extractCommonBundle.js
 * @description Logic for splitting modules into Vendor, Common, and Page-Specific bundles.
 * This script ensures strict exclusivity between bundles and applies performance heuristics 
 * to prevent Magento 2 RequireJS mixin race conditions.
 */

/**
 * The minimum number of distinct page types a module must appear in to be promoted to 'common'.
 * Strategy: used on >= 2 distinct page types (e.g., Category + Product).
 * @type {number}
 */
const MIN_USAGE_THRESHOLD = 2;

/**
 * List of bundle names considered "Transactional" or private.
 * Modules shared *only* between these bundles are NOT promoted to global common
 * to avoid bloating non-checkout pages.
 * @type {Set<string>}
 */
const TRANSACTIONAL_BUNDLES = new Set(['checkout', 'cart']);

/**
 * Explicit module paths that must always be promoted to the 'common' bundle.
 * Rationale: Force-loading the core quote singleton globally anchors its mixins
 * to prevent Singleton Lifecycle Split crashes.
 * @type {string[]}
 */
const MANUAL_COMMON_MODULES = [
    'Magento_Checkout/js/model/quote'
];

/**
 * Heuristic patterns identifying Magento 2 Mixin conventions.
 * Modules ending in these suffixes are automatically promoted to 'common'.
 * * Rationale: Mixins targeting global singletons fail if loaded in late asynchronous bundles.
 * By matching these conventions, we prevent race conditions across all extensions.
 * @type {RegExp[]}
 */
const COMMON_PATTERN_MODULES = [
    /-mixin$/,
    /-ext$/,
    /_mixin$/,
    /_ext$/
];

/**
 * List of critical infrastructure modules (exact match) forced into the Vendor bundle.
 * These are required early to prevent 404 or MIME errors during RequireJS initialization.
 * @type {Set<string>}
 */
const CRITICAL_EXACT_MODULES = new Set([
    'Magento_PageCache/js/form-key-provider',
    'Magento_Theme/js/responsive',
    'Magento_Theme/js/theme',
    'Magento_Translation/js/mage-translation-dictionary',
    'Magento_Ui/js/core/app',
    'Magento_Ui/js/modal/modal',
    'mage/requirejs/resolver'
]);

/**
 * Regular expressions for Core Infrastructure modules (Kernel) forced into Vendor.
 * @type {RegExp[]}
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
 * Regex identifying standard Magento 2 module naming conventions (Vendor_Module).
 * @type {RegExp}
 */
const MAGENTO_MODULE_REGEX = /^[A-Z][a-zA-Z0-9]+_[A-Z][a-zA-Z0-9]+\//;

/**
 * Normalizes a RequireJS module name by removing plugins and extensions.
 * * @param {string} moduleName - The raw module name (e.g., 'text!Magento_Theme/template.html').
 * @returns {string} The cleaned module path.
 */
const cleanModuleName = (moduleName) => {
    return moduleName
        .replace(/^[^!]+!/, '') // Remove plugins (e.g., text!)
        .replace(/\.js$/, '');  // Remove .js extension
};

/**
 * Checks if a module is strictly required in the Vendor bundle.
 * * @param {string} cleanName - The cleaned module name.
 * @returns {boolean} True if it is critical infrastructure.
 */
const isCriticalInfrastructure = (cleanName) => {
    if (CRITICAL_EXACT_MODULES.has(cleanName)) return true;
    return CRITICAL_PATTERN_MODULES.some((pattern) => pattern.test(cleanName));
};

/**
 * Heuristic to determine if a module should reside in 'vendor' or 'common'.
 * * @param {string} cleanName - The cleaned module name.
 * @returns {'vendor'|'common'} The target destination type.
 */
const getTargetBundleType = (cleanName) => {
    if (/\.(html|json)$/i.test(cleanName)) return 'common';
    if (isCriticalInfrastructure(cleanName)) return 'vendor';
    if (MAGENTO_MODULE_REGEX.test(cleanName)) return 'common';
    return 'vendor';
};

/**
 * Evaluates if a module matches our robust common heuristics or manual configuration.
 * * @param {string} moduleName - The original module name.
 * @returns {boolean} True if the module matches a common promotion pattern.
 */
const isExplicitlyCommon = (moduleName) => {
    const cleanName = cleanModuleName(moduleName);
    if (MANUAL_COMMON_MODULES.includes(cleanName)) return true;
    return COMMON_PATTERN_MODULES.some((pattern) => pattern.test(cleanName));
};

/**
 * Main export: Extracts common and vendor modules while preserving dependency order.
 *
 * @param {Array<{name: string, modules: Object.<string, string>}>} bundles - The list of page bundles.
 * @returns {Array<{name: string, modules: Object.<string, string>}>} The rebuilt list of bundles.
 */
export default function (bundles) {
    const vendorModules = new Map();
    const commonModules = new Map();
    const usageCounts = new Map();
    const globalOrder = new Set();
    
    // 1. Discovery Order & Usage Analysis
    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((moduleName) => {
            usageCounts.set(moduleName, (usageCounts.get(moduleName) || 0) + 1);
            globalOrder.add(moduleName);
        });
    });

    // 2. Classification & Routing
    globalOrder.forEach((moduleName) => {
        const cleanName = cleanModuleName(moduleName);
        const count = usageCounts.get(moduleName);

        const isForcedVendor = isCriticalInfrastructure(cleanName);
        const isConfigured = isExplicitlyCommon(moduleName);
        
        const sourceBundles = bundles.filter(b => b.modules[moduleName]);
        
        // Transactional Isolation: prevent checkout logic from leaking into global common.
        const isJustTransactional = sourceBundles.every(b => 
            TRANSACTIONAL_BUNDLES.has(b.name)
        );

        const isShared = count >= MIN_USAGE_THRESHOLD && !isJustTransactional;

        if (isForcedVendor || isShared || isConfigured) {
            const sourceBundle = sourceBundles[0];
            if (!sourceBundle) return;

            const modulePath = sourceBundle.modules[moduleName];
            const targetType = getTargetBundleType(cleanName);

            // Final routing logic based on determined type
            if (isForcedVendor || (targetType === 'vendor' && (isShared || isConfigured))) {
                vendorModules.set(moduleName, modulePath);
            } else {
                commonModules.set(moduleName, modulePath);
            }
        }
    });

    // 3. Cleanup Original Bundles
    // Remove moved modules from their original locations to enforce exclusivity.
    const keysToRemove = new Set([...vendorModules.keys(), ...commonModules.keys()]);

    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((key) => {
            if (keysToRemove.has(key)) {
                delete bundle.modules[key];
            }
        });
    });

    // 4. Assembly
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
