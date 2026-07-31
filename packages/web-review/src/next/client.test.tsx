/**
 * Next `ReviewOverlay` (`./client.tsx`, the App Router mount point) tests —
 * vitest + jsdom + React Testing Library.
 *
 * `ENV_ENABLED` in `./client.tsx` is read off `process.env` once, at module
 * evaluation time (deliberately — see that file's header). To exercise both
 * "env var set" and "env var unset" without one test's module-load poisoning
 * another's, every test here imports `./client` FRESH via a query-suffixed
 * specifier (`./client.tsx?fresh=N`) after setting
 * `process.env.NEXT_PUBLIC_REVIEW_ENABLED` for that test. Vite's module
 * graph treats a query-suffixed specifier as a distinct module instance
 * without evicting anything else's cache — `react`, `react-dom`,
 * `@testing-library/react`, and `../overlay/overlay-root` are all still
 * resolved to their ORIGINAL cached instances via their own unqueried
 * specifiers. `vi.resetModules()` was deliberately avoided: it clears the
 * ENTIRE module registry, including `react`/`react-dom`, which risks two
 * live React copies (one used by `@testing-library/react`'s `render`,
 * another freshly re-imported by the reset `./client`) fighting over the
 * same dispatcher.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OVERLAY_ATTR } from "../anchor";
import { ReviewApiError } from "../core/adapter";
import type { ReviewThreadView } from "../core/types";

const { usePathnameMock } = vi.hoisted(() => ({ usePathnameMock: vi.fn(() => "/") }));

// Mocked so the App Router's `PathnameContext` provider doesn't need to
// exist in jsdom, and so the "re-keys on usePathname change" test can
// control the hook's return value directly rather than simulate a real
// Next navigation.
vi.mock("next/navigation", () => ({
  usePathname: usePathnameMock,
}));

// `DynamicOverlayRoot` is `../overlay/default-surfaces`'s
// `loadWiredOverlayRoot` behind `next/dynamic`'s own dynamic `import()` —
// that loader pulls in `./overlay-root` AND, alongside it, `./composer`,
// `./panel`, and `./unlock-dialog`, so its render props
// have working defaults out of the box (see `./client.tsx`'s header, and
// `../overlay/default-surfaces`'s). The FIRST time any test opens the gate,
// all four imports have to be transformed and evaluated for the first time,
// which can take longer than a single `findByRole` poll cycle and would make
// whichever test happens to run first flaky — same rationale, and same fix,
// as `../overlay/review-overlay.test.tsx`'s own `beforeAll`. Pre-warming
// them here (still via real dynamic imports, so the "never fetched while
// off" property is exercised — just not timed against it) means every
// test's own timing reflects the gate logic, not module-load cold-start
// cost.
beforeAll(async () => {
  await Promise.all([
    import("../overlay/overlay-root"),
    import("../overlay/composer"),
    import("../overlay/panel"),
    import("../overlay/unlock-dialog"),
  ]);
});

type ClientModule = typeof import("./client");

let fresh = 0;

/**
 * Import `./client` as a brand-new module instance with
 * `NEXT_PUBLIC_REVIEW_ENABLED` set exactly as given (`undefined` = unset) —
 * see the file header for why a query-suffixed specifier is used instead of
 * `vi.resetModules()`. The cast is required because TS can't resolve a
 * dynamic template-literal specifier to a known module shape on its own;
 * `typeof import("./client")` tells it the true shape rather than widening
 * to `any`.
 */
async function importClient(
  envEnabled: string | undefined,
): Promise<ClientModule["ReviewOverlay"]> {
  vi.stubEnv("NEXT_PUBLIC_REVIEW_ENABLED", envEnabled);
  fresh += 1;
  // Built as a separate variable, not a template literal inlined directly
  // into `import(...)`: Vite's `dynamic-import-vars` plugin statically
  // rewrites the LATTER into a pre-enumerated glob lookup (it can't see a
  // query-string cache-buster as a real file and throws "Unknown variable
  // dynamic import" at runtime). A plain identifier expression falls back
  // to a genuine runtime-resolved `import()`, which Vite's module graph
  // does support with arbitrary query strings.
  const specifier = `./client.tsx?fresh=${fresh}`;
  const mod = (await import(specifier)) as ClientModule;
  return mod.ReviewOverlay;
}

/**
 * Flush pending microtasks (the `useSyncExternalStore` gate check, the
 * `next/dynamic` import's already-resolved-but-still-a-promise resolution,
 * `OverlayRoot`'s first "checking" render) inside `act()` before handing off
 * to `findByRole`'s own poll loop — same rationale as the identical helper
 * in `../overlay/review-overlay.test.tsx`.
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
  usePathnameMock.mockReturnValue("/");
  // Belt-and-braces: OverlayRoot itself stubs elementFromPoint/rects when it
  // needs them; these tests only ever get as far as the toggle button, so
  // no geometry stubbing is required beyond this.
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
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete (Document.prototype as unknown as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("Next ReviewOverlay gate", () => {
  it("renders nothing when disabled — no DOM, adapter never called", async () => {
    const ReviewOverlay = await importClient(undefined);
    const adapter = makeAdapter();

    const { container } = render(<ReviewOverlay config={{ adapter }} />);
    await flush();

    expect(container).toBeEmptyDOMElement();
    expect(document.body.querySelector(`[${OVERLAY_ATTR}]`)).toBeNull();
    expect(adapter.listThreads).not.toHaveBeenCalled();
  });

  it("mounts when config.enabled is true", async () => {
    const ReviewOverlay = await importClient(undefined);
    const adapter = makeAdapter();

    render(<ReviewOverlay config={{ adapter, enabled: true }} />);
    await flush();

    const toggle = await screen.findByRole("button", { name: /review/i });
    expect(toggle).toBeInTheDocument();
    expect(adapter.listThreads).toHaveBeenCalled();
  });

  it("mounts when NEXT_PUBLIC_REVIEW_ENABLED=1, with config.enabled left unset", async () => {
    const ReviewOverlay = await importClient("1");
    const adapter = makeAdapter();

    render(<ReviewOverlay config={{ adapter }} />);
    await flush();

    const toggle = await screen.findByRole("button", { name: /review/i });
    expect(toggle).toBeInTheDocument();
    expect(adapter.listThreads).toHaveBeenCalled();
  });

  it("config.enabled: false wins over NEXT_PUBLIC_REVIEW_ENABLED=1", async () => {
    const ReviewOverlay = await importClient("1");
    const adapter = makeAdapter();

    const { container } = render(<ReviewOverlay config={{ adapter, enabled: false }} />);
    await flush();

    expect(container).toBeEmptyDOMElement();
    expect(adapter.listThreads).not.toHaveBeenCalled();
  });

  it("mounts when the localStorage escape hatch is set (default prefix)", async () => {
    const ReviewOverlay = await importClient(undefined);
    const adapter = makeAdapter();
    window.localStorage.setItem("r3wr.enabled", "1");

    render(<ReviewOverlay config={{ adapter }} />);
    await flush();

    const toggle = await screen.findByRole("button", { name: /review/i });
    expect(toggle).toBeInTheDocument();
  });

  it("re-keys on usePathname change: re-queries threads for the new page", async () => {
    const ReviewOverlay = await importClient(undefined);
    const adapter = makeAdapter();
    usePathnameMock.mockReturnValue("/page-a");

    const { rerender } = render(<ReviewOverlay config={{ adapter, enabled: true }} />);
    await flush();
    await screen.findByRole("button", { name: /review/i });
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);

    // Simulate a client-side navigation: only the router's pathname changes
    // (no real `history.pushState` fires in this test), which is exactly
    // the case `key={pathname}` exists to cover independently of
    // `OverlayRoot`'s own `useLocation` history-patch heuristic.
    usePathnameMock.mockReturnValue("/page-b");
    rerender(<ReviewOverlay config={{ adapter, enabled: true }} />);
    await flush();

    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));
  });
});

/**
 * Regression coverage for a defect where `next/client` used to
 * `import("../overlay/overlay-root").then((m) => m.OverlayRoot)`
 * directly, bypassing the default `Composer`/`Panel`/`UnlockDialog` wiring
 * that `../overlay/review-overlay`'s `ReviewOverlay` has always shipped with
 * (see `../overlay/default-surfaces`'s header). A Next consumer mounting
 * `@r3lab/web-review/next/client` with only `config` — the documented path —
 * got pins that dropped with no composer, no panel, no unlock dialog ever
 * appearing, silently. These tests mount the Next entry the same way and
 * assert the real panel surfaces actually render, the same fake-adapter /
 * `elementFromPoint` stubbing pattern `../overlay/panels-integration.test.tsx`
 * uses for the framework-agnostic entry's equivalent coverage.
 */
describe("Next ReviewOverlay: default surfaces wired with no render props", () => {
  it("REGRESSION: renders a working composer (with its category picker) from a pin drop, with only config supplied", async () => {
    const ReviewOverlay = await importClient(undefined);
    const adapter = makeAdapter();
    const user = userEvent.setup();

    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    document.body.appendChild(target);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    render(<ReviewOverlay config={{ adapter, enabled: true }} />);
    await flush();

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);

    // The stock `Composer` — its category picker is the clearest
    // signal it's the real component, not an empty render.
    expect(await screen.findByRole("radiogroup")).toBeInTheDocument();
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
  });

  it("renders the stock panel from the Next entry with no render props supplied", async () => {
    const ReviewOverlay = await importClient(undefined);
    const adapter = makeAdapter();
    const user = userEvent.setup();

    render(<ReviewOverlay config={{ adapter, enabled: true }} />);
    await flush();

    // The launcher opens the panel and does nothing else, so activating it
    // is the whole setup this test needs.
    await user.click(await screen.findByRole("button", { name: /review panel/i }));

    expect(
      await screen.findByRole("heading", { name: /feedback on this page/i }),
    ).toBeInTheDocument();
  });

  it("renders the unlock dialog from the Next entry when the adapter reports a locked session", async () => {
    const ReviewOverlay = await importClient(undefined);
    const adapter = makeAdapter();
    adapter.listThreads.mockRejectedValue(new ReviewApiError(401, "locked"));
    const user = userEvent.setup();

    render(<ReviewOverlay config={{ adapter, enabled: true }} />);
    await flush();

    const toggle = await screen.findByRole("button", { name: /locked/i });
    await user.click(toggle);

    expect(await screen.findByPlaceholderText(/review password/i)).toBeInTheDocument();
  });

  it("an individually-supplied renderComposer overrides the default while the panel stays stock", async () => {
    const ReviewOverlay = await importClient(undefined);
    const adapter = makeAdapter();
    const user = userEvent.setup();

    const target = document.createElement("div");
    document.body.appendChild(target);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    render(
      <ReviewOverlay
        config={{ adapter, enabled: true }}
        renderComposer={() => <div data-testid="custom-composer">Custom composer</div>}
      />,
    );
    await flush();

    // Open the panel first, via the launcher: dropping a pin no longer opens
    // it, and this test needs both surfaces on screen at once to tell which
    // of them the override replaced.
    await user.click(await screen.findByRole("button", { name: /review panel/i }));
    await user.keyboard("c");
    await user.click(target);

    // The override wins over the default composer...
    expect(await screen.findByTestId("custom-composer")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    // ...while the panel, never overridden, is still the stock component.
    expect(screen.getByRole("heading", { name: /feedback on this page/i })).toBeInTheDocument();
  });
});

describe("server code stays unreachable from this module", () => {
  const sourcePath = join(process.cwd(), "src", "next", "client.tsx");
  const source = readFileSync(sourcePath, "utf8");

  it("the source imports neither the route factory (../routes) nor anything under ../server", () => {
    expect(source).not.toMatch(/from\s+["']\.\.\/routes["']/);
    expect(source).not.toMatch(/from\s+["']\.\.\/server\//);
    expect(source).not.toMatch(/node:crypto/);
    expect(source).not.toMatch(/createReviewRouteHandlers/);
  });

  // Source-level absence (above) already holds unconditionally; this adds
  // the same guarantee against the actual published artifact, per tsup's
  // per-entry bundling (see tsup.config.ts) — skipped (loudly, not
  // silently) when `dist/` hasn't been built yet, mirroring
  // `../build-output.test.ts`'s own skip pattern.
  const distPath = join(process.cwd(), "dist", "next", "client.js");
  const distExists = existsSync(distPath);

  it.skipIf(!distExists)(
    "dist/next/client.js contains no node:crypto and no createReviewRouteHandlers",
    () => {
      const built = readFileSync(distPath, "utf8");
      expect(built).not.toMatch(/node:crypto/);
      expect(built).not.toMatch(/createReviewRouteHandlers/);
    },
  );

  it.skipIf(distExists)(
    "SKIPPED — dist/next/client.js not found; run `pnpm build` before this check can run",
    () => {
      // Intentionally empty.
    },
  );
});
