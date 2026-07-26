"use client";

/**
 * `loadWiredOverlayRoot` — the ONE place `OverlayRoot`'s three render-prop
 * surfaces (`Composer`, `Panel`, `UnlockDialog` — `ThreadDetail` is `Panel`'s
 * own internal, not a render prop) are wired in as defaults.
 *
 * Two entries mount `OverlayRoot` behind a lazy boundary:
 *  - `./review-overlay.tsx` (`ReviewOverlay`, the framework-agnostic entry)
 *    behind `React.lazy`.
 *  - `../next/client.tsx` (the Next App Router entry) behind `next/dynamic`.
 *
 * Both `React.lazy` and `next/dynamic` accept the exact same loader shape —
 * `() => Promise<{ default: ComponentType<P> }>` — so this function is passed
 * directly to each: `lazy(loadWiredOverlayRoot)` on one side,
 * `dynamic(loadWiredOverlayRoot, { ssr: false })` on the other. That is what
 * makes this the single source of truth for the default set rather than a
 * second copy of it: there is exactly one function that knows how to wire
 * `Composer`/`Panel`/`UnlockDialog` into `OverlayRoot`, and every current (and
 * future) lazy-mount entry calls it instead of re-implementing it. Adding a
 * fifth mount surface later means pointing its own lazy boundary at this
 * same function — there is no second list to remember to update, so it
 * cannot drift the way `next/client.tsx` did before this file existed (it
 * imported `OverlayRoot` directly and never wired the defaults at all).
 *
 * Deliberately NOT the gate: each mount point keeps its own
 * `useSyncExternalStore` gate and its own single lazy boundary (`React.lazy`
 * vs `next/dynamic`) in front of this loader — see `../next/client.tsx`'s
 * header for why composing one mount point's gate+boundary inside the
 * other's was rejected. This module only owns "what OverlayRoot's defaults
 * are", not "when OverlayRoot mounts at all".
 *
 * The three surface imports live INSIDE this function (not as static imports
 * at module scope) so they share `OverlayRoot`'s own laziness: none of their
 * code runs, and no consumer bundler fetches their chunk, until whichever
 * lazy boundary calls this loader actually resolves it — a static import
 * here would defeat that for every consumer whose bundler code-splits on
 * this module's own `import()` calls.
 */

import type { ComponentType } from "react";

import type { OverlayRootProps } from "./overlay-root";

export async function loadWiredOverlayRoot(): Promise<{
  default: ComponentType<OverlayRootProps>;
}> {
  const [{ OverlayRoot }, { Composer }, { Panel }, { UnlockDialog }] = await Promise.all([
    import("./overlay-root"),
    import("./composer"),
    import("./panel"),
    import("./unlock-dialog"),
  ]);

  function WiredOverlayRoot(props: OverlayRootProps) {
    return (
      <OverlayRoot
        {...props}
        renderComposer={props.renderComposer ?? ((p) => <Composer {...p} />)}
        renderPanel={props.renderPanel ?? ((p) => <Panel {...p} />)}
        renderUnlockDialog={props.renderUnlockDialog ?? ((p) => <UnlockDialog {...p} />)}
      />
    );
  }

  return { default: WiredOverlayRoot };
}
