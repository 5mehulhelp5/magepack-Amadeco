export { default as category } from './category.js';
export { default as cms } from './cms.js';
export { default as product } from './product.js';
export { default as checkout } from './checkout.js';

/**
 * Collectors that must run AFTER all independent collectors complete.
 * checkout needs a populated cart (product page + add-to-cart) before it can collect.
 * @type {Set<string>}
 */
export const SEQUENTIAL_COLLECTORS = new Set(['checkout']);
