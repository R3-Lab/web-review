/**
 * `ReviewOverlay` (the mount gate) tests — vitest + jsdom + React Testing
 * Library. The one property that matters most here: when the tool is off it
 * renders NOTHING — no DOM, no adapter calls — because `OverlayRoot` sits
 * behind a `React.lazy` boundary that a disabled gate never reaches.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { OVERLAY_ATTR } from "../anchor";
import type { ReviewThreadView } from "../core/types";
import { ReviewOverlay } from "./review-overlay";

// `ReviewOverlay` loads `./overlay-root` — and, as of WP4b, `./composer`,
// `./panel`, and `./unlock-dialog` alongside it, so its render props have
// working defaults out of the box — behind a single `React.lazy` dynamic
// `import()`, by design (see that file's header) — so none of the four are
// fetched until the gate actually opens. The FIRST time any test opens the
// gate, all four imports have to be transformed and evaluated for the first
// time, which can take longer than a single `findByRole` poll cycle and
// would make whichever test happens to run first flaky. Pre-warming them
// here (still via real dynamic imports, so the "never fetched while off"
// property is exercised — just not timed against it) means every test's own
// timing reflects the gate logic, not module-load cold-start cost.
beforeAll(async () => {
  await Promise.all([
    import("./overlay-root"),
    import("./composer"),
    import("./panel"),
    import("./unlock-dialog"),
  ]);
});

/**
 * Flush pending microtasks (the `useSyncExternalStore` gate check, the lazy
 * import's already-resolved-but-still-a-promise resolution, `OverlayRoot`'s
 * first "checking" render) inside `act()` before handing off to
 * `findByRole`'s own poll loop. Without this, the very first poll can land
 * between two of those microtask turns and — since it's a mount that fires
 * once, not a recurring interval — nothing further wakes `findByRole` up
 * until its own timer-based retry, which is still correct but slower than
 * it needs to be.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeAdapter(threads: ReviewThreadView[] = []) {
  return {
    listThreads: vi.fn(() => Promise.resolve(threads)),
    getThread: vi.fn((id: string) => {
      const t = threads.find((row) => row.id === id);
      if (!t) return Promise.reject(new Error("not found"));
      return Promise.resolve(t);
    }),
    createThread: vi.fn(() => {
      throw new Error("not implemented in this fake");
    }),
    addComment: vi.fn(() => {
      throw new Error("not implemented in this fake");
    }),
    setStatus: vi.fn(() => {
      throw new Error("not implemented in this fake");
    }),
  };
}

beforeEach(() => {
  // Belt-and-braces: OverlayRoot itself stubs elementFromPoint/rects when it
  // needs them (see overlay-root.test.tsx); these tests only ever get as far
  // as the toggle button, so no geometry stubbing is required here.
  if (typeof document.elementFromPoint !== "function") {
    Object.defineProperty(Document.prototype, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => null,
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete (Document.prototype as unknown as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("ReviewOverlay gate", () => {
  it("renders nothing when disabled — no DOM, adapter never called", async () => {
    const adapter = makeAdapter();
    const { container } = render(<ReviewOverlay config={{ adapter }} />);
    await flush();

    expect(container).toBeEmptyDOMElement();
    expect(document.body.querySelector(`[${OVERLAY_ATTR}]`)).toBeNull();
    expect(adapter.listThreads).not.toHaveBeenCalled();
  });

  it("mounts when config.enabled is true", async () => {
    const adapter = makeAdapter();
    render(<ReviewOverlay config={{ adapter, enabled: true }} />);
    await flush();

    const toggle = await screen.findByRole("button", { name: /review/i });
    expect(toggle).toBeInTheDocument();
    expect(adapter.listThreads).toHaveBeenCalled();
  });

  it("mounts when the localStorage escape hatch is set (default prefix)", async () => {
    const adapter = makeAdapter();
    window.localStorage.setItem("r3wr.enabled", "1");

    render(<ReviewOverlay config={{ adapter }} />);
    await flush();

    const toggle = await screen.findByRole("button", { name: /review/i });
    expect(toggle).toBeInTheDocument();
  });

  it("mounts when the localStorage escape hatch is set under a custom prefix", async () => {
    const adapter = makeAdapter();
    window.localStorage.setItem("acme.enabled", "1");

    render(<ReviewOverlay config={{ adapter, storagePrefix: "acme" }} />);
    await flush();

    const toggle = await screen.findByRole("button", { name: /review/i });
    expect(toggle).toBeInTheDocument();
  });

  it("responds to a cross-tab storage event", async () => {
    const adapter = makeAdapter();
    render(<ReviewOverlay config={{ adapter, storagePrefix: "acme" }} />);
    await flush();

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(adapter.listThreads).not.toHaveBeenCalled();

    await act(async () => {
      window.localStorage.setItem("acme.enabled", "1");
      window.dispatchEvent(new Event("storage"));
      await Promise.resolve();
    });
    await flush();

    const toggle = await screen.findByRole("button", { name: /review/i });
    expect(toggle).toBeInTheDocument();
  });
});
