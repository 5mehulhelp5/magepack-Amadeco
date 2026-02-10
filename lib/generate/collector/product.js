import { createPageCollector } from './factory.js';

/**
 * Collects RequireJS modules from a specific Product page (PDP).
 */
export default createPageCollector('product', 'productUrl');
