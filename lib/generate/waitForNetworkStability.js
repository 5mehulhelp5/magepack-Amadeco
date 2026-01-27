/**
 * @typedef {Object} NetworkStabilityOptions
 * @property {number} [idleMs=800] Minimum quiet window with no new requests started.
 * @property {number} [timeoutMs=15000] Hard timeout to avoid blocking indefinitely.
 * @property {Set<string>} [includeResourceTypes] Only count these Puppeteer resource types.
 * @property {RegExp[]} [excludeUrlPatterns] Ignore matching requests (analytics, pixels, etc.).
 */

/**
 * Wait until the page reaches a stable network window.
 *
 * Stability definition:
 * - no inflight requests
 * - no new request started during `idleMs`
 *
 * This is a deterministic alternative to fixed sleeps and usually faster.
 *
 * @param {import('puppeteer').Page} page Puppeteer page instance.
 * @param {NetworkStabilityOptions} [options]
 * @returns {Promise<void>}
 */
export async function waitForNetworkStability(page, options = {}) {
    const {
        idleMs = 800,
        timeoutMs = 15000,
        includeResourceTypes,
        excludeUrlPatterns = [
            /google-analytics\.com/i,
            /googletagmanager\.com/i,
            /doubleclick\.net/i,
            /facebook\.com\/tr/i,
            /hotjar\.com/i,
            /datadog|newrelic|sentry/i,
        ],
    } = options;

    /** @type {Set<string>} */
    const inflight = new Set();

    let lastRequestStartedAt = Date.now();
    let idleTimer = null;

    /** @type {(value?: void | PromiseLike<void>) => void} */
    let resolveDone;
    /** @type {(reason?: any) => void} */
    let rejectDone;

    const donePromise = new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });

    const shouldCount = (req) => {
        try {
            const url = req.url();
            if (excludeUrlPatterns.some((re) => re.test(url))) return false;

            if (includeResourceTypes && includeResourceTypes.size > 0) {
                return includeResourceTypes.has(req.resourceType());
            }

            return true;
        } catch {
            return false;
        }
    };

    const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);

        // We only consider stability when nothing is inflight
        if (inflight.size !== 0) return;

        const elapsedSinceLastStart = Date.now() - lastRequestStartedAt;
        const remaining = Math.max(0, idleMs - elapsedSinceLastStart);

        idleTimer = setTimeout(() => {
            // Double-check at fire time
            if (inflight.size === 0) resolveDone();
        }, remaining);
    };

    const onRequest = (req) => {
        if (!shouldCount(req)) return;

        lastRequestStartedAt = Date.now();
        inflight.add(req._requestId || req.url()); // fallback if _requestId is not present
        armIdleTimer();
    };

    const onRequestDone = (req) => {
        if (!shouldCount(req)) return;

        inflight.delete(req._requestId || req.url());
        armIdleTimer();
    };

    const onRequestFailed = (req) => {
        if (!shouldCount(req)) return;

        inflight.delete(req._requestId || req.url());
        armIdleTimer();
    };

    const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);

        page.off('request', onRequest);
        page.off('requestfinished', onRequestDone);
        page.off('requestfailed', onRequestFailed);
    };

    // Attach listeners
    page.on('request', onRequest);
    page.on('requestfinished', onRequestDone);
    page.on('requestfailed', onRequestFailed);

    // Kick-off in case the page is already quiet
    armIdleTimer();

    // Hard timeout guard
    const timeout = setTimeout(() => {
        cleanup();
        rejectDone(new Error(`Network stability timeout after ${timeoutMs}ms (inflight=${inflight.size}).`));
    }, timeoutMs);

    try {
        await donePromise;
    } finally {
        clearTimeout(timeout);
        cleanup();
    }
}
