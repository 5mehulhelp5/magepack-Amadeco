/**
 * @file lib/generate/excludedModules.js
 * @description Defines modules that must be excluded from Magepack bundle collection.
 *
 * Modules listed here are never collected during the `generate` phase. They will be
 * loaded individually by RequireJS at runtime, which ensures proper dependency resolution
 * through RequireJS's native shim configuration and plugin system.
 *
 * Exclusion is necessary for modules that:
 *   - Are RequireJS built-in constructs (require, module, exports).
 *   - Are loaded synchronously and cannot be deferred (mixins).
 *   - Are jQuery plugins relying on shim-configured dependencies that break when
 *     wrapped by Magepack's `wrapNonAmd` pattern, because the shim config may not
 *     be available at `define`-time inside a bundle script.
 *
 * @module generate/excludedModules
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.0.1: Added `fotorama/fotorama` to fix `$.fn.fotorama is not a function` error.
 *     Fotorama is a non-AMD jQuery plugin that registers itself on `$.fn`. When bundled,
 *     the `wrapNonAmd` wrapper resolves shim deps at `define()`-time via
 *     `require.s.contexts._.config.shim[...]`. However, when the bundle script loads,
 *     the shim configuration may not yet be merged by RequireJS, causing the dependency
 *     array to resolve to `[]`. This means Fotorama's factory executes before jQuery
 *     has registered `$.fn`, resulting in the fatal error. Excluding Fotorama allows
 *     RequireJS to load it individually with proper shim resolution, guaranteeing
 *     jQuery is available before Fotorama initializes. The cost is one additional
 *     HTTP request, which is an acceptable trade-off for runtime reliability.
 */
export default [
    /**
     * Loaded and defined synchronously by Magento's RequireJS interceptor.
     * Cannot be deferred or bundled without breaking the mixin resolution chain.
     */
    'mixins',

    /**
     * Built-in RequireJS pseudo-modules.
     * These are virtual constructs handled internally by the loader and have no
     * physical file on disk. Attempting to bundle them causes resolution errors.
     */
    'require',
    'module',
    'exports',

    /**
     * Also known as legacyBuild.min.js, still used by some legacy extensions.
     * Overwrites native JavaScript object prototypes (Array, String, etc.),
     * which can cause unpredictable side effects when bundled with modern code.
     */
    'prototype',

    /**
     * Fotorama jQuery Plugin.
     *
     * Non-AMD library that registers `$.fn.fotorama` on the jQuery prototype.
     * Must be loaded via RequireJS's shim configuration to guarantee jQuery
     * is fully initialized before Fotorama's factory executes.
     *
     * The `wrapNonAmd` wrapper pattern used by Magepack resolves shim dependencies
     * dynamically at `define()`-time. Inside a bundle script, this evaluation happens
     * before RequireJS has fully merged all `require.config()` calls, causing the
     * shim dependency on `jquery` to be silently dropped (resolved as `[]`).
     *
     * @see https://github.com/artpolikarpov/fotorama
     * @see lib/bundle/moduleWrapper.js → wrapNonAmd()
     */
    'fotorama/fotorama'
];
