import fs from 'node:fs';
import path from 'node:path';
import { FILES } from '../utils/constants.js';

/**
 * Checks if minification is enabled by looking for minified requirejs config.
 *
 * @param {string} localePath
 * @returns {boolean}
 */
const checkMinifyOn = (localePath) => {
    return fs.existsSync(path.join(localePath, FILES.REQUIREJS_CONFIG_MIN));
};

export default checkMinifyOn;
