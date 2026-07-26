"use client";

/**
 * `useLocation` — a framework-agnostic replacement for Next's `usePathname`.
 *
 * The single-app review tool this package generalizes from re-keyed threads
 * on route change via Next's `usePathname()`. This package has no router
 * dependency (no reference implementation to port from — this is new work)
 * and must work in plain React, so this hook reports the current page's
 * href and re-renders subscribers on any client-side navigation:
 *
 *  - `popstate` (back/forward) and `hashchange` (in-page anchor nav) are
 *    real browser events — a plain listener covers them.
 *  - SPA routers (Next.js, React Router, …) navigate by calling
 *    `history.pushState` / `history.replaceState` directly, which fires
 *    NEITHER event. Those two methods are monkey-patched — once per page,
 *    ref-counted across every mounted `useLocation` subscriber, never
 *    patched twice — to notify subscribers after calling through to the
 *    original. The exact original function references are restored the
 *    moment the LAST subscriber unmounts, so the global is never left
 *    patched once nothing is using it.
 *
 * Built on `useSyncExternalStore`, which makes two things easy to get
 * wrong if you're not careful:
 *  - `getSnapshot` returns `window.location.href` — a primitive. Returning
 *    a freshly-allocated object here (e.g. `{ href }`) would make every
 *    snapshot "different" by reference on every render, and
 *    `useSyncExternalStore` would re-render in an infinite loop chasing a
 *    snapshot that never stabilizes.
 *  - `getServerSnapshot` returns a single stable module-level constant,
 *    never computed per call, so the server render and the first client
 *    render agree and hydration never mismatches.
 */

import { useSyncExternalStore } from "react";

/** Stable constant so SSR and the first client render never disagree. */
const SERVER_SNAPSHOT = "";

/** Every mounted `useLocation` subscriber's React-provided change callback. */
const listeners = new Set<() => void>();

/** How many subscribers currently hold the history patch. */
let patchRefCount = 0;
/** The exact original references, restored verbatim when the count hits 0. */
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Read `history[key]` as a plain value rather than `history.pushState`
 * directly. A bare `history.pushState` member expression is a "this"-sensitive
 * method reference (ESLint's `unbound-method` rightly flags extracting it
 * as a value, since calling it later without `history` as `this` would
 * throw) — but here it is never called unbound, only stored so the exact
 * original function object can be handed back to `history.pushState` on
 * restore. Going through `Reflect.get` reads the same property without
 * tripping that (otherwise-correct) rule.
 */
function unboundHistoryMethod<K extends "pushState" | "replaceState">(
  key: K,
): History[K] {
  return Reflect.get(history, key) as History[K];
}

/**
 * Patch `history.pushState`/`replaceState` on the first subscriber; every
 * later subscriber just bumps the ref count. `originalPushState` /
 * `originalReplaceState` capture the UNBOUND references exactly as they
 * were before patching (not a `.bind()`'d copy), so restoring them later
 * hands back the identical function object a caller had before this hook
 * ever touched `history`.
 */
function retainHistoryPatch(): void {
  if (patchRefCount === 0) {
    originalPushState = unboundHistoryMethod("pushState");
    originalReplaceState = unboundHistoryMethod("replaceState");
    // Bound copies to actually call through — invoking the unbound native
    // method without `history` as `this` throws "Illegal invocation" in
    // real browsers.
    const push = originalPushState.bind(history);
    const replace = originalReplaceState.bind(history);
    history.pushState = (...args: Parameters<History["pushState"]>) => {
      push(...args);
      notify();
    };
    history.replaceState = (...args: Parameters<History["replaceState"]>) => {
      replace(...args);
      notify();
    };
  }
  patchRefCount += 1;
}

/** Release one subscriber's hold on the patch; restore originals at zero. */
function releaseHistoryPatch(): void {
  patchRefCount -= 1;
  if (patchRefCount === 0 && originalPushState && originalReplaceState) {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    originalPushState = null;
    originalReplaceState = null;
  }
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(onStoreChange);
  retainHistoryPatch();
  window.addEventListener("popstate", onStoreChange);
  window.addEventListener("hashchange", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
    window.removeEventListener("hashchange", onStoreChange);
    releaseHistoryPatch();
  };
}

function getSnapshot(): string {
  return window.location.href;
}

function getServerSnapshot(): string {
  return SERVER_SNAPSHOT;
}

/**
 * The current page's href. Updates on `popstate`, `hashchange`, and any
 * `history.pushState`/`replaceState` call (including ones made by a SPA
 * router, not just this hook). Safe to call from any number of components
 * at once — each gets its own subscription, and the underlying
 * `history` patch is shared and ref-counted.
 */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
