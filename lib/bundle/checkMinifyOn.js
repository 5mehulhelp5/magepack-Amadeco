/**
 * @file lib/bundle/checkMinifyOn.js
 * @description Detects whether Magento's JavaScript minification is enabled for a given locale.
 *
 * Detection is performed by checking the existence of the minified RequireJS
 * configuration file (`requirejs-config.min.js`) on disk. If the file exists,
 * Magento's static content deploy was run with minification enabled.
 *
 * @module bundle/checkMinifyOn
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.0.1: Migrated from synchronous `fs.existsSync` to async `fs/promises`
 *     to align with the fully asynchronous bundling pipeline and prevent
 *     blocking the Node.js event loop during concurrent locale processing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { FILES } from '../utils/constants.js';

/**
 * Checks if Magento's JavaScript minification is enabled for a specific locale
 * by verifying the presence of the minified RequireJS configuration file.
 *
 * @async
 * @param {string} localePath - The absolute path to the locale's static directory
 *   (e.g., `pub/static/frontend/Vendor/Theme/en_US`).
 * @returns {Promise<boolean>} Resolves to `true` if minification is enabled, `false` otherwise.
 *
 * @example
 *   const isMinified = await checkMinifyOn('/var/www/pub/static/frontend/Amadeco/future/fr_FR');
 *   // => true (if requirejs-config.min.js exists)
 */
const checkMinifyOn = async (localePath) => {
    try {
        await fs.access(path.join(localePath, FILES.REQUIREJS_CONFIG_MIN));
        return true;
    } catch {
        return false;
    }
};

export default checkMinifyOn;
