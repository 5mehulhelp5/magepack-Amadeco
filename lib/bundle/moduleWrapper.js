const jsesc = require('jsesc');
const acorn = require('acorn');
const walk = require('acorn-walk');
const MagicString = require('magic-string');

/**
 * Helper to safely parse JS code.
 * Returns null if parsing fails (e.g. syntax error in source file).
 */
const parseAst = (content) => {
    try {
        return acorn.parse(content, {
            ecmaVersion: 2020,
            sourceType: 'module',
            locations: false
        });
    } catch (e) {
        return null;
    }
};

/**
 * Tells if given module is a non-AMD JavaScript code.
 * AST Logic: Scans for any CallExpression named 'define'.
 *
 * @param {string} moduleContents Contents of the module.
 */
const isNonAmd = (moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return true; // Treat unparseable code as non-AMD to be safe

    let hasDefine = false;
    walk.simple(ast, {
        CallExpression(node) {
            if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
                hasDefine = true;
            }
        }
    });

    return !hasDefine;
};

/**
 * Wraps non-AMD module so it can be safely inlined into the bundle.
 * (Kept original implementation as this is a simple template wrapper)
 *
 * @param {string} moduleName Name of the AMD module.
 * @param {string} content Contents of the module to wrap.
 * @returns {string}
 */
const wrapNonAmd = (moduleName, content) => {
    return `define('${moduleName}', (require.s.contexts._.config.shim['${moduleName}'] && require.s.contexts._.config.shim['${moduleName}'].deps || []), function() {

    ${content}

    return (require.s.contexts._.config.shim['${moduleName}'] && require.s.contexts._.config.shim['${moduleName}'].exportsFn && require.s.contexts._.config.shim['${moduleName}'].exportsFn());
}.bind(window));`;
};

/**
 * Tells if given module is a text type.
 *
 * @param {string} modulePath Module path.
 */
const isText = (modulePath) => !modulePath.endsWith('.js');

/**
 * Wraps a text module (HTML, JSON, etc.) so it can be safely inlined into the bundle.
 *
 * @param {string} moduleName Name of the AMD module.
 * @param {string} content Contents of the module to wrap.
 * @returns {string}
 */
const wrapText = (moduleName, content) => {
    const escapedContent = jsesc(content);
    return `define('${moduleName}', function() {
    return '${escapedContent}';
});`;
};

/**
 * Tells if given module contains anonymous AMD module definition.
 * AST Logic: Finds a 'define' call where the first argument is NOT a string literal.
 *
 * @param {string} moduleContents Contents of the module to wrap.
 */
const isAnonymousAmd = (moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return false;

    let isAnonymous = false;
    walk.simple(ast, {
        CallExpression(node) {
            if (isAnonymous) return; // Stop if already found
            
            if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
                const args = node.arguments;
                // It is anonymous if it has arguments, and the first argument is NOT a String Literal
                if (args.length > 0) {
                    const firstArg = args[0];
                    if (firstArg.type !== 'Literal' || typeof firstArg.value !== 'string') {
                        isAnonymous = true;
                    }
                }
            }
        }
    });

    return isAnonymous;
};

/**
 * Changes anonymous AMD module into the named one to be able to bundle it.
 * AST Logic: Locates the 'define' call and injects the module name at the exact index.
 *
 * @param {string} moduleName Name of the module.
 * @param {string} moduleContents Contents of the module to wrap.
 */
const wrapAnonymousAmd = (moduleName, moduleContents) => {
    const ast = parseAst(moduleContents);
    if (!ast) return moduleContents;

    const magicString = new MagicString(moduleContents);
    let modified = false;

    walk.simple(ast, {
        CallExpression(node) {
            if (modified) return; // Only wrap the first define

            if (node.callee.type === 'Identifier' && node.callee.name === 'define') {
                const args = node.arguments;
                
                // Case 1: define(deps, factory) -> define('name', deps, factory)
                // Case 2: define(factory) -> define('name', factory)
                
                // We verify it's anonymous (first arg is not a string)
                if (args.length > 0 && (args[0].type !== 'Literal' || typeof args[0].value !== 'string')) {
                    magicString.appendLeft(args[0].start, `'${moduleName}', `);
                    modified = true;
                }
            }
        }
    });

    return modified ? magicString.toString() : moduleContents;
};

module.exports = {
    isNonAmd,
    wrapNonAmd,
    isText,
    wrapText,
    isAnonymousAmd,
    wrapAnonymousAmd,
};
