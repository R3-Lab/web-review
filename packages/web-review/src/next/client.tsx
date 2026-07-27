"use client";

/**
 * Next.js App Router mount point for the review overlay — a Next-flavoured
 * sibling of `../overlay/review-overlay`'s framework-agnostic `ReviewOverlay`,
 * exported from the separate `@r3lab/web-review/next/client` subpath (see
 * `./index.ts`'s header for why the split exists and what must never cross
 * it: this file must never import `./routes` or anything under `../server`,
 * directly or transitively).
 *
 * Renders **nothing at all** unless the tool is switched on: no DOM, no
 * fetches, no key handlers, no polling, no `MutationObserver` — and, because
 * the real overlay sits behind a `next/dynamic` boundary, not even its
 * JavaScript (or `../overlay/overlay.css`, or `@zumer/snapdom`) is EVALUATED
 * until the gate actually opens: this file's own gate returns `false` before
 * render ever reaches `<DynamicOverlayRoot>`, so `next/dynamic`'s loader
 * (`loadWiredOverlayRoot`) is never called and the underlying `import()`
 * never fires from application code.
 *
 * That is a guarantee about EXECUTION, not about download. See "Bundle
 * cost" in the README for the one caveat that survives it: Next.js's
 * Turbopack production builds can still ship the chunk's *bytes* in the
 * initial HTML (as an unconditional `<script async>`) even with the gate
 * closed, because Turbopack's own default chunking pre-fetches a route's
 * entire async-import graph regardless of whether the runtime path that
 * would trigger it is ever taken — confirmed not to be something this
 * module's source shape controls (same result building from this package's
 * `dist/` or straight from this file; `next build --webpack` does not have
 * the problem).
 *
 * ## Why `next/dynamic`, not `React.lazy` — and why a parallel gate instead
 * of composing `ReviewOverlay`
 *
 * `ReviewOverlay` already ships a complete gate (`useSyncExternalStore` +
 * `config.enabled`/localStorage) in front of a `React.lazy` boundary around
 * `OverlayRoot`. The idiomatic Next path for that same boundary is
 * `next/dynamic` with `ssr: false` instead of bare `React.lazy` — the docs
 * are explicit that `ssr: false` is legal only in a Client Component (this
 * file), never a Server Component, and `next/dynamic` (unlike `React.lazy`
 * on its own) bails out of server rendering cleanly rather than suspending
 * indefinitely during prerender.
 *
 * Composing `ReviewOverlay` under an additional `next/dynamic` wrapper was
 * considered and rejected: it would leave the actually-heavy chunk
 * (`OverlayRoot`) behind `ReviewOverlay`'s own `React.lazy`, never satisfying
 * "use `next/dynamic` for the overlay chunk" at all — only a second,
 * redundant boundary around the (tiny) gate component itself would be
 * `next/dynamic`. Worse, that redundant outer boundary would need its own
 * copy of the enabled/localStorage gate anyway, just to avoid evaluating
 * even `ReviewOverlay`'s trivial module before the Next-only checks (the env
 * var) are applied — two independent `useSyncExternalStore` subscriptions to
 * the same localStorage key, with all the drift risk that implies. Instead,
 * this file owns ONE gate (mirroring `ReviewOverlay`'s exactly, plus the env
 * var) in front of ONE lazy boundary — the one that actually satisfies "use
 * `next/dynamic` for the overlay chunk". What that boundary loads is
 * covered below, in "Default surfaces".
 *
 * Three ways to switch it on, checked in this order — an explicit
 * `config.enabled` always wins (same precedent as `ResolvedReviewConfig.screenshots`
 * in `../core/config`, where an explicit `false` always wins over what the
 * adapter supports):
 *  1. `config.enabled: true` / `false` — explicit override, either direction.
 *  2. `NEXT_PUBLIC_REVIEW_ENABLED=1` at build time — how review deployments
 *     switch it on without touching `config.enabled` in code. Named to match
 *     the example already given in `../overlay/review-overlay`'s own doc
 *     comment ("typically from an env var THEY read, e.g.
 *     `process.env.NEXT_PUBLIC_REVIEW_ENABLED === "1"`").
 *  3. `localStorage["{storagePrefix}.enabled"] = "1"` — the same escape
 *     hatch `ReviewOverlay` offers, so the tool can be turned on by hand
 *     against a build that shipped without the env var. Not a security
 *     boundary, for the same reason noted on `ReviewOverlay`: whatever
 *     actually authorises writes is unaffected by this flag.
 *
 * `ENV_ENABLED` is read directly off `process.env` at module scope (not
 * inside a function) specifically so Next's build-time inlining of
 * `NEXT_PUBLIC_*` vars can fold the whole comparison to a literal: when the
 * var is unset, `process.env.NEXT_PUBLIC_REVIEW_ENABLED` is replaced with
 * `undefined` and `undefined === "1"` becomes the literal `false`, which a
 * minifier constant-folds through every branch that reads `ENV_ENABLED`
 * below. In a build where env is the ONLY trigger a consumer relies on
 * (`config.enabled` left unset, no localStorage flag ever written), that
 * makes `readGate` provably return `false` and the gate stays closed, so
 * `DynamicOverlayRoot` is never rendered and its `next/dynamic` loader is
 * never called — the same "statically dead when off" property
 * `../overlay/review-overlay`'s own doc comment attributes to its
 * `config.enabled`/localStorage gate, just with one more provably-dead
 * input. See the file header's caveat above: "never called" is not the same
 * claim as "the chunk's bytes are never requested" — Turbopack's own
 * chunking can still put them on the wire.
 *
 * ## Default surfaces
 *
 * `DynamicOverlayRoot` is `../overlay/default-surfaces`'s
 * `loadWiredOverlayRoot` — the SAME loader `../overlay/review-overlay` passes
 * to `React.lazy` — passed to `next/dynamic` instead. Both `React.lazy` and
 * `next/dynamic` accept an identical loader shape
 * (`() => Promise<{ default: ComponentType<P> }>`), so one function serves
 * both lazy boundaries: `OverlayRoot`'s `Composer`/`Panel`/`UnlockDialog`
 * defaults are wired in exactly once, here and in `ReviewOverlay` alike, and
 * cannot drift between the two entries the way they did before this module
 * existed (this file used to `import("../overlay/overlay-root").then((m) =>
 * m.OverlayRoot)` directly, bypassing the default wiring entirely). Render
 * props passed to THIS file's `ReviewOverlay` still flow straight through to
 * `loadWiredOverlayRoot`'s `WiredOverlayRoot`, which prefers them
 * (`props.renderComposer ?? ...`) over its own defaults — so overriding one
 * surface here still leaves the other two stock, same as the
 * framework-agnostic entry.
 *
 * ## Route-change awareness
 *
 * `OverlayRoot` already tracks navigation on its own, via
 * `../client/use-location`'s framework-agnostic `useLocation` (popstate,
 * hashchange, and a monkey-patched `history.pushState`/`replaceState` —
 * which is how Next's router navigates too, so that mechanism already
 * fires). Inside Next specifically, though, `usePathname()` from
 * `next/navigation` is the canonical, router-native signal for "which page
 * is this" — not a same-origin inference over browser history internals.
 * This file feeds it through as an ADDITIONAL, belt-and-braces guarantee on
 * top of (not instead of) `useLocation`'s own reactivity: `pathname` is used
 * as `DynamicOverlayRoot`'s React `key`, so a path change forces a full
 * remount — a fresh gate probe and a fresh `listThreads` for the new page —
 * using Next's own router state rather than relying solely on the
 * history-patch heuristic to have fired correctly. `OverlayRoot`'s module
 * (once dynamically imported) is cached by `next/dynamic`/`React.lazy`
 * internally, so remounting on a path change costs a component re-mount, not
 * a second network fetch.
 *
 * ## Server Component safety
 *
 * This module carries `"use client"`, so importing `ReviewOverlay` from a
 * Server Component layout and rendering it as a child does not pull that
 * layout across the client boundary — its `metadata` export and static
 * generation are unaffected. See `../overlay/review-overlay`'s own header
 * for the same property, ported in shape from a working single-app review
 * tool's `FeedbackOverlay` / `FeedbackOverlayInner` split.
 */

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { resolveConfig } from "../core/config";
import type { ReviewConfig } from "../core/config";
import { loadWiredOverlayRoot } from "../overlay/default-surfaces";
import type {
  ComposerRenderProps,
  PanelRenderProps,
  UnlockRenderProps,
} from "../overlay/overlay-root";

/** Same default as `resolveConfig` (`../core/config`) — used before a config is resolved, to read the escape hatch. */
const DEFAULT_STORAGE_PREFIX = "r3wr";

/**
 * Build-time enablement switch — see the file header's "Three ways to
 * switch it on" for precedence against `config.enabled` and the localStorage
 * escape hatch, and for why this must stay a module-scope `process.env`
 * read rather than a function call.
 */
const ENV_ENABLED = process.env.NEXT_PUBLIC_REVIEW_ENABLED === "1";

/**
 * `OverlayRoot`, wired with its default `Composer`/`Panel`/`UnlockDialog`
 * surfaces, behind `next/dynamic` rather than `React.lazy` — see the file
 * header's "Why `next/dynamic`" for why this replaces (rather than wraps)
 * `ReviewOverlay`'s own lazy boundary, and its "Default surfaces" section for
 * why `loadWiredOverlayRoot` (`../overlay/default-surfaces`) — not a direct
 * `import("../overlay/overlay-root")` — is what's passed here. `ssr: false`
 * is legal here only because this module is a Client Component; the overlay
 * is browser-only (`document.elementFromPoint`, `getSelection`,
 * `localStorage`, a portal to `<body>`), so there is nothing to prerender.
 */
const DynamicOverlayRoot = dynamic(loadWiredOverlayRoot, { ssr: false });

export interface ReviewOverlayProps {
  config: ReviewConfig;
  /** See `ComposerRenderProps` in `../overlay/overlay-root` — the composer. */
  renderComposer?: (props: ComposerRenderProps) => ReactNode;
  /** See `PanelRenderProps` in `../overlay/overlay-root` — the thread panel/detail. */
  renderPanel?: (props: PanelRenderProps) => ReactNode;
  /** See `UnlockRenderProps` in `../overlay/overlay-root` — the unlock dialog. */
  renderUnlockDialog?: (props: UnlockRenderProps) => ReactNode;
}

export function ReviewOverlay({
  config,
  renderComposer,
  renderPanel,
  renderUnlockDialog,
}: ReviewOverlayProps) {
  const pathname = usePathname();
  const active = useOverlayActive(config);
  // Resolved unconditionally (hooks can't be called after an early return),
  // but cheap and never touches the DOM — see the identical note on
  // `ReviewOverlay` in `../overlay/review-overlay`.
  const resolved = useMemo(() => resolveConfig(config), [config]);

  if (!active) return null;

  return (
    <DynamicOverlayRoot
      key={pathname}
      config={resolved}
      renderComposer={renderComposer}
      renderPanel={renderPanel}
      renderUnlockDialog={renderUnlockDialog}
    />
  );
}

/**
 * The gate, read as an external store rather than in an effect — same shape
 * as `useOverlayActive` in `../overlay/review-overlay`, with `ENV_ENABLED`
 * folded in. The server snapshot is hard-coded `false`, which is the
 * load-bearing part: `DynamicOverlayRoot` is never even reached during
 * prerender, so the overlay cannot influence static generation of any page
 * it's mounted on.
 */
function useOverlayActive(config: ReviewConfig): boolean {
  const storageKey = escapeHatchKey(config.storagePrefix ?? DEFAULT_STORAGE_PREFIX);

  const subscribe = useCallback((onChange: () => void) => {
    // `storage` fires in OTHER tabs — flip the hatch in devtools on one tab
    // and the site's other tabs follow, same as `ReviewOverlay`.
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
  if (ENV_ENABLED) return true;
  try {
    return window.localStorage.getItem(storageKey) === "1";
  } catch {
    // Storage unavailable (private mode) — stay off.
    return false;
  }
}

export const VERSION = "0.1.0";
