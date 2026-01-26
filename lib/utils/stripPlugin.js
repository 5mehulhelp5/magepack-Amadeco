/**
 * Strips plugin from module name.
 * @param {string} moduleName
 * @returns {string}
 */
const stripPlugin = (moduleName) => moduleName.replace(/^[^!].+!/, '');

export default stripPlugin;
