/**
 * `useLocation` unit tests (vitest + jsdom). No `@testing-library/react` is
 * a dependency of this package, so this file drives a real `react-dom`
 * root directly (`createRoot` + `act`) rather than pulling one in. Covers:
 *  (a) reports the initial href on mount;
 *  (b) updates on a `popstate` event (back/forward);
 *  (c) updates on `history.pushState` (what SPA routers actually call);
 *  (d) two simultaneous subscribers both see the same navigation;
 *  (e) the history patch is ref-counted and the ORIGINAL `pushState`
 *      reference is restored once the last subscriber unmounts;
 *  (f) a single navigation produces exactly one extra render — proof there
 *      is no `getSnapshot`-identity infinite-render loop.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { useLocation } from "./use-location";

/**
 * Read `history[key]` as a plain value for identity comparison (`.toBe()`),
 * without tripping ESLint's `unbound-method` rule — mirrors
 * `use-location.ts`'s own `unboundHistoryMethod`: this is never CALLED
 * unbound, only compared by reference.
 */
function unboundHistoryMethod<K extends "pushState" | "replaceState">(
  key: K,
): History[K] {
  return Reflect.get(history, key) as History[K];
}

function currentPushState(): History["pushState"] {
  return unboundHistoryMethod("pushState");
}

interface LocationProbe {
  readonly renderCount: number;
  readonly latest: string | undefined;
  unmount(): void;
}

const activeProbes: LocationProbe[] = [];

function renderLocationProbe(): LocationProbe {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let renderCount = 0;
  const renders: string[] = [];

  function Probe() {
    const href = useLocation();
    renderCount += 1;
    renders.push(href);
    return null;
  }

  act(() => {
    root.render(createElement(Probe));
  });

  const probe: LocationProbe = {
    get renderCount() {
      return renderCount;
    },
    get latest() {
      return renders[renders.length - 1];
    },
    unmount() {
      const idx = activeProbes.indexOf(probe);
      if (idx !== -1) activeProbes.splice(idx, 1);
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
  activeProbes.push(probe);
  return probe;
}

// Belt-and-braces: even if a test fails mid-way, unmount every probe it
// created so the module-level history patch never leaks into the next test.
afterEach(() => {
  while (activeProbes.length > 0) {
    activeProbes[0]!.unmount();
  }
});

describe("useLocation", () => {
  it("reports the initial href", () => {
    const probe = renderLocationProbe();
    expect(probe.latest).toBe(window.location.href);
  });

  it("updates on a popstate event", () => {
    // Change the URL via the TRUE original replaceState (captured before
    // this probe subscribes and patches it), so this test proves the
    // popstate listener specifically — not the pushState patch.
    const originalReplaceState = history.replaceState.bind(history);
    const probe = renderLocationProbe();
    const before = probe.latest;

    act(() => {
      originalReplaceState({}, "", "/popstate-path");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(probe.latest).not.toBe(before);
    expect(probe.latest).toContain("/popstate-path");
  });

  it("updates on history.pushState", () => {
    const probe = renderLocationProbe();

    act(() => {
      history.pushState({}, "", "/pushed-path");
    });

    expect(probe.latest).toContain("/pushed-path");
  });

  it("keeps multiple simultaneous subscribers in sync", () => {
    const probeA = renderLocationProbe();
    const probeB = renderLocationProbe();

    act(() => {
      history.pushState({}, "", "/multi-subscriber");
    });

    expect(probeA.latest).toContain("/multi-subscriber");
    expect(probeB.latest).toContain("/multi-subscriber");
  });

  it("restores the original history.pushState only after the last unsubscribe", () => {
    const originalPushState = currentPushState();

    const probeA = renderLocationProbe();
    const probeB = renderLocationProbe();
    expect(currentPushState()).not.toBe(originalPushState);

    probeA.unmount();
    expect(currentPushState()).not.toBe(originalPushState); // probeB still mounted

    probeB.unmount();
    expect(currentPushState()).toBe(originalPushState); // fully restored
  });

  it("produces exactly one extra render per navigation (no infinite loop)", () => {
    const probe = renderLocationProbe();
    expect(probe.renderCount).toBe(1);

    act(() => {
      history.pushState({}, "", "/one-nav");
    });

    expect(probe.renderCount).toBe(2);
  });
});
