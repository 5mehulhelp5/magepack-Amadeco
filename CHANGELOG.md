# Changelog - Amadeco Magepack (ESM Edition)

All notable changes to this project will be documented in this file.
This fork has been specifically re-architected to meet the strict requirements of Adobe Commerce (Magento 2.4.8+), with an absolute focus on performance (KISS principle), CI/CD resilience, and advanced static compression.

## [Amadeco Edition] - 2026-03-03

### ✨ Added
- **Native Zstandard (Zstd) Compression:** Complete replacement of dynamic server-side compression in favor of static `.zst` pre-compilation. Utilizes the host OS's native CLI binary (`node:child_process`) to eliminate memory padding bugs (`U+0000` null characters) associated with WebAssembly ports.
- **"Ultra" Compression Levels:** Implemented Zstd level 19/22 (`--ultra`) and Brotli Max (level 11) running concurrently (`Promise.all`). This guarantees static bundles that are 15% to 30% lighter than on-the-fly server compression.
- **Graceful Degradation:** Added automatic detection of the `zstd` utility on the host server. If missing, the script gracefully warns the user and continues generating Gzip/Brotli assets without crashing the build.
- **Strict CSP Support (Subresource Integrity):** Added the `sriUpdater.js` service, which automatically calculates and updates SHA-256 hashes in `sri-hashes.json`, making the generated bundles 100% compliant with Magento 2.4.8+ strict CSP policies.
- **Secure HTML/Knockout Minification:** The HTML template minifier now strictly ignores Magento's virtual comments (e.g., ``), preventing the destruction of KnockoutJS DOM bindings.

### 🚀 Changed
- **ES Modules (ESM) Architecture:** Full source code migration (Node 18+) to native ESM standards (native imports, top-level await) for faster boot times and modern code maintainability.
- **Dynamic CLI Loading:** The `bundle` and `generate` commands are now loaded via dynamic imports, drastically accelerating the CLI's boot time.
- **Atomic CI/CD Deployments:** Bundles are now compiled into a temporary `magepack_build` directory, followed by an atomic folder swap. This guarantees zero downtime and eliminates 404 errors during live production deployments.
- **Terser Minification Strategy:** Introduced `safe` and `aggressive` minification modes for granular control over payload reduction.
- **Terser Security Auto-Fallback:** Added regex detection (`SENSITIVE_PATTERNS`) that automatically downgrades the minification strategy to `safe` for sensitive core libraries (jQuery, Knockout, Stripe, PayPal) to prevent fatal execution errors (`$ is undefined`, missing parentheses).
- **Transactional Isolation (Bundle Splitting):** Overhauled the `extractCommonBundle.js` logic to strictly exclude checkout and cart-related scripts from the `bundle-common.js` file, significantly reducing the payload on the homepage.
- **I/O Batching (OS Crash Prevention):** The file processor now reads dependencies in batches of 50 to prevent OS-level `EMFILE` (Too many open files) errors on large, multi-locale Magento catalogs.
- **Injected RequireJS Hook:** Directly injects `window.__magepackOrderedModules` into the Headless browser context to capture the exact execution order, resolving the classic Magento "RequireJS dependency hell".

### 🐛 Fixed
- **RequireJS Race Condition Fix:** Modified `configInjector.js` to explicitly enforce the `.min` extension within the `requirejs-config.min.js` `paths` mapping. This prevents RequireJS from accidentally attempting to load unminified files if the Magento interceptor initializes too late.
- **X11 Server Crash Fix (Headless Mode):** Reconfigured Puppeteer to natively use the lightweight Chrome Headless Shell engine (`headless: 'shell'`). The `-d` (debug) CLI flag was decoupled from Chrome's visual UI mode, preventing "Unable to open X display" crashes on monitorless SSH Linux servers.
- **Infinite XHR Loops Fix:** The `waitForNetworkStability` function now explicitly ignores external tracking pixels (Google Analytics, Facebook, etc.) to prevent the crawler from hanging indefinitely on unresolved 3rd-party requests.

### 🔒 Security
- Removed the vulnerable and memory-unstable WebAssembly dependency (`@oneidentity/zstd-js`) in favor of the host operating system's native executable.
