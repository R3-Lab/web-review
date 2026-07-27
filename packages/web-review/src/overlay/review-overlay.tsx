"use client";

/**
 * `ReviewOverlay` — the mount point and its gate.
 *
 * Ported in shape from a working single-app review tool's `FeedbackOverlay`
 * (`feedback-overlay.tsx`). This file is deliberately tiny and is the ONLY
 * thing a consumer's layout should import. It renders **nothing at all**
 * unless the tool is switched on: no DOM, no fetches, no key handlers, no
 * polling, no `MutationObserver` — and, because the real overlay sits behind
 * a `React.lazy` boundary, not even its JavaScript (or `./overlay.css`, or
 * `@zumer/snapdom`) is ever EVALUATED: `useOverlayActive` (below) returns
 * `false` before render ever reaches `<LazyOverlayRoot>`, so `React.lazy`
 * never calls `loadWiredOverlayRoot` and the underlying `import()` never
 * fires from application code.
 *
 * That is a guarantee about execution, not about download. Whether the
 * chunk's *bytes* ever reach the browser when it's switched off depends on
 * the bundler wrapping this component: confirmed on Next.js, where
 * Turbopack's production builds can still ship them in the initial HTML (an
 * unconditional `<script async>`, regardless of this gate) while `next
 * build --webpack` does not — see `../next/client.tsx`'s own header and
 * "Bundle cost" in the README for the full account. Nothing about this
 * file's own source controls that; it is purely the consuming bundler's
 * chunking strategy for a statically-reachable `import()` boundary.
 *
 * Two ways to switch it on:
 *  1. `config.enabled: true` — how a consumer flips it on for a preview
 *     deployment (typically from an env var THEY read, e.g.
 *     `process.env.NEXT_PUBLIC_REVIEW_ENABLED === "1"` — this package takes
 *     no opinion on env vars, unlike the reference, which inlined one).
 *  2. `localStorage["{storagePrefix}.enabled"] = "1"` — an escape hatch so
 *     the tool can be turned on by hand against a build that shipped
 *     without the flag. It is not a security boundary: whatever actually
 *     authorises writes (`ReviewAdapter.unlock`, or the preview
 *     deployment's own auth) is unaffected by this flag — it only decides
 *     whether the overlay's chrome exists on the page at all.
 *
 * `ssr: false` (Next's `dynamic`) isn't available in plain React — this
 * package must work without `next`. `React.lazy` + `Suspense` is the
 * framework-agnostic equivalent: the overlay is browser-only
 * (`document.elementFromPoint`, `getSelection`, `localStorage`, a portal to
 * `<body>`), so there is nothing to prerender, and `Suspense`'s `null`
 * fallback means there is nothing to show while the chunk loads either.
 *
 * `LazyOverlayRoot` wires the four panel surfaces (`Composer`, `Panel`,
 * `UnlockDialog` — `ThreadDetail` is `Panel`'s own internal, not a render
 * prop) in as `OverlayRoot`'s default `renderComposer` / `renderPanel` /
 * `renderUnlockDialog`, so the overlay is complete out of the box: a
 * consumer only has to supply `config`. Each stays overridable — a consumer
 * passing their own `renderComposer` etc. still wins over the default. That
 * wiring lives in `./default-surfaces`'s `loadWiredOverlayRoot`, shared with
 * `../next/client.tsx`'s own lazy boundary, so this is the only place the
 * default set is read from rather than a second copy of it — see that
 * module's header for why. Its surface imports live INSIDE that shared
 * loader (not as static imports at the top of this file) so they share
 * `OverlayRoot`'s laziness: none of the panel surfaces' code runs, and no
 * consumer bundler fetches their chunk, until the gate actually opens — a
 * static import here would defeat that for every consumer whose own bundler
 * code-splits on this `import()` boundary.
 */

import type { ReactNode } from "react";
import { lazy, Suspense, useCallback, useMemo, useSyncExternalStore } from "react";

import { resolveConfig } from "../core/config";
import type { ReviewConfig } from "../core/config";
import { loadWiredOverlayRoot } from "./default-surfaces";
import type {
  ComposerRenderProps,
  PanelRenderProps,
  UnlockRenderProps,
} from "./overlay-root";

/** Same default as `resolveConfig` — used before a config is resolved, to read the escape hatch. */
const DEFAULT_STORAGE_PREFIX = "r3wr";

const LazyOverlayRoot = lazy(loadWiredOverlayRoot);

export interface ReviewOverlayProps {
  config: ReviewConfig;
  /** See `ComposerRenderProps` in `./overlay-root` — the composer. */
  renderComposer?: (props: ComposerRenderProps) => ReactNode;
  /** See `PanelRenderProps` in `./overlay-root` — the thread panel/detail. */
  renderPanel?: (props: PanelRenderProps) => ReactNode;
  /** See `UnlockRenderProps` in `./overlay-root` — the unlock dialog. */
  renderUnlockDialog?: (props: UnlockRenderProps) => ReactNode;
}

export function ReviewOverlay({
  config,
  renderComposer,
  renderPanel,
  renderUnlockDialog,
}: ReviewOverlayProps) {
  const active = useOverlayActive(config);
  // Resolved unconditionally (hooks can't be called after an early return),
  // but cheap — a handful of `??` defaults — and never touches the DOM, so
  // computing it on a render where the overlay is inactive costs nothing
  // worth guarding against.
  const resolved = useMemo(() => resolveConfig(config), [config]);

  if (!active) return null;

  return (
    <Suspense fallback={null}>
      <LazyOverlayRoot
        config={resolved}
        renderComposer={renderComposer}
        renderPanel={renderPanel}
        renderUnlockDialog={renderUnlockDialog}
      />
    </Suspense>
  );
}

/**
 * The gate, read as an external store rather than in an effect.
 *
 * The server snapshot is hard-coded `false`, which is the load-bearing
 * part: `LazyOverlayRoot` is never even reached during prerender, so the
 * overlay cannot influence static generation of any page it's mounted on —
 * not its markup, not its cacheability. The client snapshot is read on
 * hydration and again whenever another tab writes the escape hatch key.
 */
function useOverlayActive(config: ReviewConfig): boolean {
  const storageKey = escapeHatchKey(config.storagePrefix ?? DEFAULT_STORAGE_PREFIX);

  const subscribe = useCallback((onChange: () => void) => {
    // `storage` fires in OTHER tabs, which is exactly the case worth
    // handling: flip the hatch in devtools on one tab and the site's other
    // tabs follow.
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  }, []);

  const getSnapshot = useCallback(() => readGate(config, storageKey), [config, storageKey]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getServerSnapshot(): boolean {
  return false;
}

function escapeHatchKey(prefix: string): string {
  return `${prefix}.enabled`;
}

function readGate(config: ReviewConfig, storageKey: string): boolean {
  if (config.enabled === true) return true;
  if (config.enabled === false) return false;
  try {
    return window.localStorage.getItem(storageKey) === "1";
  } catch {
    // Storage unavailable (private mode) — stay off.
    return false;
  }
}
