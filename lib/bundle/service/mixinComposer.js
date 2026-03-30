/**
 * @file lib/bundle/service/mixinComposer.js
 * @description Build-time AMD mixin composition for Magepack bundles.
 *
 * ## Problem
 *
 * Magento's `mixins!` RequireJS plugin intercepts `require.load()` to wrap target
 * modules with mixin factories. When a target is bundled, `require.load()` is never
 * called — RequireJS resolves it from its internal registry, and mixins are silently
 * skipped. Excluding modules from bundles solves the mixin issue but defeats the
 * purpose of bundling.
 *
 * ## Solution
 *
 * This service composes a mixin target with its factories **at build-time** into a
 * single self-contained code block. The composed output:
 *
 *   1. Renames the original target's `define()` to a private ID with
 *      `__magepack_original__` suffix (e.g., `"swatch-renderer__magepack_original__"`).
 *   2. Keeps each mixin factory's `define()` intact (unchanged).
 *   3. Appends a new composite `define("target", ["target__magepack_original__", "mixin0", ...])`.
 *      When any consumer `require()`s the target, RequireJS resolves the full dependency
 *      tree (original + all mixins), calls the composite factory which chains them,
 *      and returns the fully-mixed result.
 *   4. Reports the mixin IDs as "absorbed" so the processor removes them from
 *      both the bundle output and the `require.config({bundles:...})` declaration.
 *
 * ## Why define()-based composition instead of a synchronous IIFE
 *
 * RequireJS named `define("name", [deps], factory)` does NOT execute the factory
 * synchronously. It queues the module and only resolves dependencies + calls the
 * factory when someone `require()`s it. A synchronous IIFE reading
 * `ctx.defined["name"]` would find `undefined` because the factory hasn't run yet.
 *
 * By using a proper `define()` with dependencies, RequireJS guarantees all
 * participants are resolved before the composite factory executes.
 *
 * ## Why mixin modules are absorbed (not declared in bundles config)
 *
 * If a mixin factory were declared in `require.config({bundles: ...})`, RequireJS
 * would consider it "loaded" globally. On pages that load the target individually
 * (without the bundle), the `mixins!` plugin would find the mixin already
 * "provided" by the bundle and skip loading it — but the bundle isn't loaded on
 * that page, so the mixin silently disappears. By removing mixin factories from
 * the declaration, they remain invisible to RequireJS's bundle resolution,
 * allowing `mixins!` to load them individually on non-bundled pages.
 *
 * @module bundle/service/mixinComposer
 * @author Amadeco Dev Team
 *
 * @changelog
 *   - v3.1.0: Initial implementation.
 */

import consola from 'consola';

/**
 * Composes a mixin target with its mixin factories into a single code block.
 *
 * The composed output is a concatenation of:
 *   1. The original target `define()` — **renamed** with `__magepack_original__` suffix.
 *   2. Each mixin factory `define()` — unchanged.
 *   3. A composite `define("target", ["target__magepack_original__", "mixin0", ...])` that
 *      receives all resolved values and applies the mixin chain.
 *
 * RequireJS guarantees that all dependencies are resolved before calling the
 * composite factory, so this works correctly even with deep async dependency trees.
 *
 * @param {string} targetId - The RequireJS module ID of the mixin target
 *   (e.g., `"Magento_Swatches/js/swatch-renderer"`).
 * @param {string} targetContent - The wrapped AMD source code of the target module.
 *   Must contain a `define("targetId", ...)` call.
 * @param {Array<{ mixinId: string, wrappedContent: string }>} mixinSources -
 *   Ordered array of mixin factories to apply. Each entry contains the mixin's
 *   RequireJS module ID and its wrapped AMD source code.
 * @returns {{ compositeContent: string, absorbedMixinIds: string[] }}
 *   - `compositeContent`: The full composed code block (renamed target + mixins + composite define).
 *   - `absorbedMixinIds`: Array of mixin module IDs that were absorbed into the
 *     composite and should be removed from the bundle declaration.
 */
export const composeMixinTarget = (targetId, targetContent, mixinSources) => {
    if (!mixinSources || mixinSources.length === 0) {
        return {
            compositeContent: targetContent,
            absorbedMixinIds: [],
        };
    }

    const absorbedMixinIds = mixinSources.map((s) => s.mixinId);

    // Escape the target ID for safe embedding in generated JS strings
    const escapedTargetId = targetId
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');

    // ---------------------------------------------------------------
    // STEP A: Rename the original target define()
    //
    // The original define("swatch-renderer", [deps], factory) must be
    // renamed to define("swatch-renderer__magepack_original__", [deps], factory)
    // so that the composite define("swatch-renderer", [...]) can reference
    // it as a dependency. Without this rename, RequireJS would see two
    // define() calls with the same name and silently ignore the second.
    // ---------------------------------------------------------------
    const originalSuffix = '__magepack_original__';
    const renamedTargetId = `${targetId}${originalSuffix}`;

    // Build regex that matches define("targetId" or define('targetId'
    const escapedForRegex = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const definePattern = new RegExp(
        `define\\(["']${escapedForRegex}["']`,
        'g'
    );

    const renamedTargetContent = targetContent.replace(
        definePattern,
        `define("${renamedTargetId}"`
    );

    // ---------------------------------------------------------------
    // Build the orchestrator via define() + require()
    //
    // WHY NOT a synchronous IIFE:
    //   RequireJS named define("name", [deps], factory) does NOT execute
    //   the factory synchronously. It queues the module and only resolves
    //   dependencies + calls the factory when someone require()s it.
    //   A synchronous IIFE reading ctx.defined["name"] would find
    //   `undefined` because the factory hasn't run yet.
    //
    // SOLUTION: Re-define the target module with a new define() that
    //   lists the original target (under a renamed ID) + all mixin
    //   factories as dependencies. RequireJS will resolve the full
    //   dependency tree before calling the factory, guaranteeing all
    //   participants are available.
    //
    // MECHANISM:
    //   1. The original define("target", ...) is renamed to
    //      define("target__magepack_original__", ...) in the bundle.
    //   2. A new define("target", ["target__magepack_original__", "mixin1", ...])
    //      is emitted. Its factory receives all resolved values, applies
    //      the chain, and returns the composed result.
    //   3. When any consumer require()s "target", RequireJS resolves this
    //      new define(), which pulls the original + all mixins, composes
    //      them, and returns the fully mixed result.
    //
    // This is functionally identical to what mixins! does at runtime,
    // but without needing require.load() interception.
    // ---------------------------------------------------------------

    // Build dependency array for the composite define():
    //   ["target__magepack_original__", "mixin0", "mixin1", ...]
    const escapedRenamedId = renamedTargetId
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');

    const compositeDeps = [
        `"${escapedRenamedId}"`,
        ...mixinSources.map((s) => {
            const esc = s.mixinId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `"${esc}"`;
        }),
    ];

    // Build factory parameter names
    const compositeParams = [
        '__original__',
        ...mixinSources.map((_, i) => `__mixin${i}__`),
    ];

    // Build the chaining expression: __mixin2__(__mixin1__(__mixin0__(__original__)))
    let chainExpr = '__original__';
    mixinSources.forEach((_, i) => {
        chainExpr = `__mixin${i}__(${chainExpr})`;
    });

    const orchestratorLines = [
        '',
        `/* MAGEPACK MIXIN COMPOSER: ${targetId} (${mixinSources.length} mixin(s)) */`,
        `define("${escapedTargetId}", [${compositeDeps.join(', ')}], function(${compositeParams.join(', ')}) {`,
        `    "use strict";`,
        `    return ${chainExpr};`,
        `});`,
    ];

    // ---------------------------------------------------------------
    // Assemble the composite
    //
    // Order matters:
    //   1. Renamed original define("target__magepack_original__", ...)
    //      → registers the raw, unmixed module under the renamed ID.
    //   2. Each mixin factory define() — unchanged, registers wrappers.
    //   3. Composite define("target", ["target__magepack_original__", "mixin0", ...])
    //      → when require()d, RequireJS resolves the full dependency tree,
    //        calls the factory with all resolved values, applies the chain,
    //        and returns the fully composed result.
    //
    // RequireJS guarantees that dependencies are resolved before the
    // factory is called, so all participants are available.
    // ---------------------------------------------------------------

    // CRITICAL: Each block MUST end with ";\n" to prevent ASI failures.
    // Without explicit semicolons, Terser's aggressive mode strips
    // whitespace and produces: define(...)define(...) which JavaScript
    // parses as define(...)(define(...)) → "define(...) is not a function".

    const ensureTrailingSemicolon = (code) => {
        const trimmed = code.trimEnd();
        return trimmed.endsWith(';') ? trimmed + '\n' : trimmed + ';\n';
    };

    const parts = [
        ensureTrailingSemicolon(renamedTargetContent),
        ...mixinSources.map((s) => ensureTrailingSemicolon(s.wrappedContent)),
        orchestratorLines.join('\n'),
    ];

    const compositeContent = parts.join('\n');

    consola.debug(
        `   🧬 Composed "${targetId}" with ${mixinSources.length} mixin(s): ` +
        absorbedMixinIds.map((id) => id.split('/').pop()).join(', ')
    );

    return {
        compositeContent,
        absorbedMixinIds,
    };
};
