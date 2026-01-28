import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import logger from '../utils/logger.js';

/**
 * Fetches the original content of a file bypassing Puppeteer's interception loop.
 * It mirrors the original request headers (Cookies, Auth) to ensure access to protected environments.
 *
 * @param {string} urlString - The absolute URL to fetch.
 * @param {Object} headers - The headers from the original Puppeteer request.
 * @returns {Promise<string>} The raw file content.
 */
const fetchOriginalContent = (urlString, headers) => {
    return new Promise((resolve, reject) => {
        try {
            const url = new URL(urlString);
            const adapter = url.protocol === 'https:' ? https : http;
            
            // Filter out headers that might cause issues (like host) or are unnecessary
            const safeHeaders = { ...headers };
            delete safeHeaders['host'];
            delete safeHeaders['accept-encoding']; // We want plain text, not gzip

            const options = {
                headers: safeHeaders,
                method: 'GET'
            };

            const req = adapter.request(urlString, options, (res) => {
                let data = '';
                
                // Handle redirects automatically if needed, or non-200 status
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    resolve(fetchOriginalContent(res.headers.location, headers));
                    return;
                }

                if (res.statusCode !== 200) {
                    // If we can't fetch it, we can't sanitize it. Reject.
                    reject(new Error(`Status ${res.statusCode}`));
                    return;
                }

                res.setEncoding('utf8');
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(data));
            });

            req.on('error', (e) => reject(e));
            req.end();
        } catch (e) {
            reject(e);
        }
    });
};

/**
 * Robust Magepack Blocker.
 * * STRATEGY:
 * 1. Network Interception: Hijack 'requirejs-config.js'.
 * 2. Sanitization: Download the real file, strip the Magepack Regex block, serve clean content.
 * 3. Fallback: Silently kill any bundle request that slips through (no error thrown).
 *
 * @param {import('puppeteer').Page} page 
 */
export default async (page) => {
    await page.setRequestInterception(true);

    page.on('request', async (request) => {
        const url = request.url();

        // --- 1. CONFIGURATION SANITIZATION ---
        // We target both the minified and non-minified versions of the config file.
        if (url.includes('requirejs-config') && url.endsWith('.js')) {
            try {
                const originalContent = await fetchOriginalContent(url, request.headers());
                
                // CRITICAL: The Regex that removes the persistence problem.
                // Matches everything between the markers defined in lib/bundle.js
                const cleanedContent = originalContent.replace(
                    /\/\* MAGEPACK START \*\/[\s\S]*?\/\* MAGEPACK END \*\//g, 
                    ''
                );

                const wasCleaned = originalContent.length !== cleanedContent.length;

                if (wasCleaned) {
                    logger.debug(`   ✨ Sanitized ${url.split('/').pop()} (Removed Magepack config)`);
                }

                await request.respond({
                    status: 200,
                    contentType: 'application/javascript',
                    body: cleanedContent
                });
                return;

            } catch (e) {
                // If fetching fails (e.g. server error), let the request continue normally.
                // We don't want to break the page load just because sanitation failed.
                // logger.warn(`   ⚠️  Sanitization skipped for ${url}: ${e.message}`);
                await request.continue();
                return;
            }
        }

        // --- 2. BUNDLE SUPPRESSION ---
        // Even if config is stripped, if a hardcoded script tag or prefetch exists,
        // we simply abort the request to save bandwidth.
        // WE DO NOT FLAG AS DIRTY. We assume we are in control.
        if (url.includes('magepack/bundle-')) {
            logger.warn(`🛑 DETECTED: Existing bundle: ${request.url()}`);
            await request.abort();
            return;
        }

        // --- 3. DEFAULT BEHAVIOR ---
        try {
            await request.continue();
        } catch (error) {
            // Puppeteer specific: Ignore "Request is already handled" errors
        }
    });
};
