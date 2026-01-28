import { isCommon } from './blockMagepack.js';

/**
 * ============================================================================
 * CONSTANTS & CONFIGURATION
 * ============================================================================
 */

/**
 * MIN_USAGE_THRESHOLD determines the promotion strategy for shared modules.
 *
 * @type {number}
 * @const
 * @default 2
 *
 * Strategy:
 * - 2: Balanced (Standard). If a module is used on >= 2 page types (e.g., Home + Product),
 * it moves to 'common'. Reduces code duplication.
 * - 3: Speed-First. A module must be widely used to be promoted. Keeps the initial bundle lighter
 * but might duplicate code in specific bundles (e.g., Checkout & Cart).
 */
const MIN_USAGE_THRESHOLD = 3;

/**
 * List of critical module paths (exact match) that MUST be included in the Vendor bundle.
 * These files are often requested early by the browser before the mapping is fully processed,
 * causing "NS_ERROR_CORRUPTED" or 404 errors if they are not immediately available.
 *
 * @type {string[]}
 * @const
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
 * Regular expressions identifying Core Infrastructure modules.
 * These modules constitute the application kernel (Loader, Base Utils, Framework).
 * They must be loaded first (Vendor Bundle) to prevent race conditions.
 *
 * @type {RegExp[]}
 * @const
 */
const CRITICAL_PATTERN_MODULES = [
    /^mage\/(?!calendar|gallery)/, // Magento Core Libs (excluding heavy UI widgets)
    /^requirejs\//,                // RequireJS internal components
    /^text$/,                      // RequireJS Text Plugin
    /^domReady$/,                  // RequireJS DomReady Plugin
    /^jquery\/jquery(\.min)?\.js$/,// jQuery Core
    /^jquery\/jquery-migrate/,     // jQuery Migrate
    /^jquery\/jquery-storageapi/,  // jQuery Storage Utility
    /^underscore$/,                // Lo-Dash/Underscore
    /^knockoutjs\/knockout$/       // Knockout MVVM Library
];

/**
 * Regular expression to identify a standard Magento 2 module naming convention (PSR-4).
 * Format: Vendor_Module/...
 * Used to distinguish "Business Logic" (Common) from "Libraries" (Vendor).
 *
 * @type {RegExp}
 * @const
 */
const MAGENTO_MODULE_REGEX = /^[A-Z][a-zA-Z0-9]+_[A-Z][a-zA-Z0-9]+\//;

/**
 * ============================================================================
 * HELPER FUNCTIONS (DRY/SOLID)
 * ============================================================================
 */

/**
 * Normalizes a RequireJS module name for analysis.
 * Removes loader prefixes (e.g., 'text!') and file extensions.
 *
 * @param {string} moduleName - Raw module ID.
 * @returns {string} Cleaned module name.
 */
const cleanModuleName = (moduleName) => {
    return moduleName
        .replace(/^[^!]+!/, '') // Remove plugins like 'text!' or 'domReady!'
        .replace(/\.js$/, '');  // Remove .js extension if present
};

/**
 * Checks if a module is strictly required in the Vendor bundle for stability.
 *
 * @param {string} cleanName - Normalized module name.
 * @returns {boolean} True if the module is critical.
 */
const isCriticalInfrastructure = (cleanName) => {
    // 1. Check Exact Matches (User Defined overrides)
    if (CRITICAL_EXACT_MODULES.includes(cleanName)) {
        return true;
    }

    // 2. Check Patterns (Framework Core)
    return CRITICAL_PATTERN_MODULES.some((pattern) => pattern.test(cleanName));
};

/**
 * Determines the destination bundle type for a shared module.
 *
 * Logic:
 * - If it's a Template/JSON data -> Common (Business Logic).
 * - If it's a Critical Module -> Vendor (Infrastructure).
 * - If it looks like a Magento Module (Vendor_Module) -> Common (Business Logic).
 * - Everything else (npm libs, third-party) -> Vendor (Infrastructure).
 *
 * @param {string} cleanName - Normalized module name.
 * @returns {'vendor'|'common'} The target bundle type.
 */
const getTargetBundleType = (cleanName) => {
    if (/\.(html|json)$/i.test(cleanName)) {
        return 'common';
    }

    if (isCriticalInfrastructure(cleanName)) {
        return 'vendor';
    }

    if (MAGENTO_MODULE_REGEX.test(cleanName)) {
        return 'common';
    }

    return 'vendor';
};

/**
 * ============================================================================
 * MAIN LOGIC
 * ============================================================================
 */

/**
 * Orchestrates the extraction of shared code into 'vendor' and 'common' bundles.
 *
 * Algorithm:
 * 1. Analyze usage frequency and preserve loading order across all bundles.
 * 2. Classify modules based on Security (Critical) and Optimization (Threshold).
 * 3. Route modules to 'vendor' or 'common' buckets.
 * 4. Clean up original bundles.
 * 5. Reassemble the bundle list with new shared layers.
 *
 * @param {Object[]} bundles - The list of collected bundles.
 * @returns {Object[]} The optimized list of bundles.
 */
export default function (bundles) {
    const vendorModules = new Map();
    const commonModules = new Map();
    
    /** @type {Record<string, number>} */
    const usageCounts = {};
    
    /** @type {string[]} Preserves the global browser discovery order */
    const discoveryOrder = [];

    // ---------------------------------------------------------
    // STEP 1: Global Analysis (Frequency & Order)
    // ---------------------------------------------------------
    bundles.forEach((bundle) => {
        Object.keys(bundle.modules).forEach((moduleName) => {
            // Count usage for optimization threshold
            usageCounts[moduleName] = (usageCounts[moduleName] || 0) + 1;

            // Record first appearance to maintain RequireJS dependency order
            if (!discoveryOrder.includes(moduleName)) {
                discoveryOrder.push(moduleName);
            }
        });
    });

    // ---------------------------------------------------------
    // STEP 2: Classification & Routing
    // ---------------------------------------------------------
    discoveryOrder.forEach((moduleName) => {
        const cleanName = cleanModuleName(moduleName);
        const count = usageCounts[moduleName];

        // Criteria A: Stability (Force critical files to prevent Race Conditions)
        const isForced = isCriticalInfrastructure(cleanName);

        // Criteria B: Optimization (Only share if used frequently enough)
        const isShared = count >= MIN_USAGE_THRESHOLD;

        // Criteria C: Configuration (Explicitly defined in magepack.config.js)
        const isConfigured = isCommon(moduleName);

        // DECISION: Should we extract this module?
        if (isForced || isShared || isConfigured) {
            // Retrieve module path from the first bundle that contains it
            const sourceBundle = bundles.find((b) => b.modules[moduleName]);
            
            if (sourceBundle) {
                const modulePath = sourceBundle.modules[moduleName];
                const targetType = getTargetBundleType(cleanName);

                // ROUTING
                if (targetType === 'vendor') {
                    vendorModules.set(moduleName, modulePath);
                } else {
                    commonModules.set(moduleName, modulePath);
                }
            }
        }
    });

    // ---------------------------------------------------------
    // STEP 3: Cleanup Original Bundles
    // ---------------------------------------------------------
    bundles.forEach((bundle) => {
        // Remove modules that have been moved to vendor or common
        const keysToRemove = [...vendorModules.keys(), ...commonModules.keys()];
        keysToRemove.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(bundle.modules, key)) {
                delete bundle.modules[key];
            }
        });
    });

    // ---------------------------------------------------------
    // STEP 4: Assembly & Return
    // ---------------------------------------------------------
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
