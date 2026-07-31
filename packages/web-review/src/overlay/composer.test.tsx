/**
 * `Composer` interaction tests (vitest + jsdom + React Testing Library).
 *
 * Renders `Composer` directly against a minimal `ComposerRenderProps` fixture
 * — no `OverlayRoot` involved — so these tests exercise exactly the seam
 * `Composer` implements against (`./overlay-root`'s `ComposerRenderProps`) in
 * isolation. The full pin → composer → panel round trip through the real
 * seam lives in `./panels-integration.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { ReviewApiError } from "../core/adapter";
import { resolveConfig } from "../core/config";
import type { ReviewConfig } from "../core/config";
import type { Anchor, ReviewerIdentity } from "../core/types";
import { Composer } from "./composer";
import type { ComposerRenderProps } from "./overlay-root";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeAnchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    selector: "#target",
    textHint: "Target",
    tagName: "div",
    classes: [],
    ancestorPath: [],
    rect: { x: 10, y: 10, w: 100, h: 40 },
    offsetPct: { x: 0.5, y: 0.5 },
    viewport: { w: 1024, h: 768, dpr: 1, scrollW: 1024, scrollH: 2000 },
    urlKey: "/",
    href: "https://example.test/",
    kind: "element",
    ...overrides,
  };
}

// Deliberately NOT typed against the `ReviewAdapter` interface (its methods
// are declared method-shorthand, which gives them an implicit `this` and
// trips `@typescript-eslint/unbound-method` the moment a test references
// `adapter.unlock` as a bare value in `expect(...)`). Structural inference
// from these `vi.fn()` properties satisfies `ReviewAdapter` at every call
// site that needs it (`resolveConfig({ adapter, ... })` below) without ever
// naming the interface.
function makeAdapter() {
  return {
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    addComment: vi.fn(),
    setStatus: vi.fn(),
    unlock: vi.fn(() => Promise.resolve()),
    // Present by default so `resolveConfig`'s `screenshots` resolves `true`
    // and the shot-note tests below exercise the note's real gating, not a
    // config that already suppresses it. Tests for the "no `uploadScreenshot`
    // at all" case build their own adapter without this key.
    uploadScreenshot: vi.fn(),
  };
}

function renderComposer(
  propsOverride: Partial<ComposerRenderProps> = {},
  configOverride: Omit<Partial<ReviewConfig>, "adapter"> = {},
  adapterOverride: Partial<ReturnType<typeof makeAdapter>> = {},
) {
  const adapter = { ...makeAdapter(), ...adapterOverride };
  const config = resolveConfig({ adapter, ...configOverride });
  const onCancel = vi.fn();
  const onSubmit = vi.fn(() => Promise.resolve());
  const onUnlocked = vi.fn();
  const props: ComposerRenderProps = {
    anchor: makeAnchor(),
    config,
    identity: null,
    shotState: "idle",
    // The panel is an axis of its own now, so neither value is "normal" —
    // see `panelOpen`'s doc comment on `ComposerRenderProps`. `true` is the
    // one that exercises the composer's clamp, hence the default here.
    panelOpen: true,
    // "right" is what `panelSideForEdge` returns for the launcher's default
    // edge, so the fixture describes the default configuration.
    panelSide: "right",
    onCancel,
    onSubmit,
    onUnlocked,
    ...propsOverride,
  };
  const utils = render(<Composer {...props} />);
  return { ...utils, adapter, config, onCancel, onSubmit, onUnlocked, props };
}

describe("Composer", () => {
  it("renders categories from config.categories, including a fully custom set", () => {
    renderComposer(
      {},
      { categories: [{ id: "ux", label: "UX Issue" }, { id: "perf", label: "Performance" }] },
    );
    expect(screen.getByRole("radio", { name: /ux issue/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /performance/i })).toBeInTheDocument();
    // The built-in categories are gone entirely when the consumer overrides them.
    expect(screen.queryByRole("radio", { name: /^design$/i })).not.toBeInTheDocument();
  });

  it("submits the typed category/title/body/name via onSubmit", async () => {
    const user = userEvent.setup();
    const identity: ReviewerIdentity = { id: "u1", name: "Ada" };
    const { onSubmit } = renderComposer({ identity });

    await user.click(screen.getByRole("radio", { name: /bug/i }));
    await user.type(screen.getByLabelText(/title/i), "Broken button");
    await user.type(screen.getByLabelText(/comment/i), "It does nothing");
    await user.click(screen.getByRole("button", { name: /add feedback/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        category: "bug",
        title: "Broken button",
        body: "It does nothing",
        // No identity name field is shown once `identity` is set, so the
        // submitted name is the identity's own — not blank, not re-typed.
        name: "Ada",
      }),
    );
  });

  it("calls onCancel when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderComposer();
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on Escape", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderComposer();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the name field only when identity is null", () => {
    renderComposer({ identity: null });
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    cleanup();

    renderComposer({ identity: { id: "u1", name: "Ada" } });
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument();
  });

  it("reflects each shotState, when screenshots are enabled", () => {
    renderComposer({ shotState: "pending" });
    expect(screen.getByText(/capturing a screenshot/i)).toBeInTheDocument();
    cleanup();

    renderComposer({ shotState: "done" });
    expect(screen.getByText(/screenshot attached/i)).toBeInTheDocument();
    cleanup();

    renderComposer({ shotState: "idle" });
    expect(screen.getByText(/submitting without one/i)).toBeInTheDocument();
    cleanup();

    renderComposer({ shotState: "error" });
    expect(screen.getByText(/submitting without one/i)).toBeInTheDocument();
  });

  // WP25 / defect 1: `adapter.uploadScreenshot` resolving `null` is a
  // documented, supported outcome (storage failed, or none configured) —
  // NOT the same as a screenshot actually being attached. The composer must
  // never claim otherwise for that outcome.
  it('never claims "attached" for shotState "unavailable" (uploadScreenshot resolved null) — it says so honestly instead', () => {
    renderComposer({ shotState: "unavailable" });
    expect(screen.queryByText(/screenshot attached/i)).not.toBeInTheDocument();
    expect(screen.getByText(/screenshot/i)).toBeInTheDocument();
    // Distinct from the plain "no screenshot" copy used for idle/error — a
    // capture WAS attempted here, only the storage step didn't happen.
    expect(screen.getByText(/couldn't be saved/i)).toBeInTheDocument();
  });

  it("suppresses the screenshot note entirely when the adapter has no uploadScreenshot at all — even if shotState somehow claims done", () => {
    renderComposer({ shotState: "done" }, {}, { uploadScreenshot: undefined });
    expect(screen.queryByText(/screenshot attached/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/screenshot/i)).not.toBeInTheDocument();
  });

  it("suppresses the screenshot note entirely when the consumer explicitly disabled screenshots — even if shotState somehow claims done", () => {
    renderComposer({ shotState: "done" }, { screenshots: false });
    expect(screen.queryByText(/screenshot attached/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/screenshot/i)).not.toBeInTheDocument();
  });

  it("on a 401 from onSubmit, shows the password field, then retries submit after unlock without losing the draft", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn<ComposerRenderProps["onSubmit"]>()
      .mockRejectedValueOnce(new ReviewApiError(401, "locked"))
      .mockResolvedValueOnce(undefined);
    const { adapter, onUnlocked } = renderComposer({
      identity: { id: "u1", name: "Ada" },
      onSubmit,
    });

    await user.type(screen.getByLabelText(/comment/i), "It broke");
    await user.click(screen.getByRole("button", { name: /add feedback/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    const passwordField = await screen.findByPlaceholderText(/review password/i);
    // The draft is still on screen — nothing typed was lost by the failed submit.
    expect(screen.getByLabelText(/comment/i)).toHaveValue("It broke");

    await user.type(passwordField, "secret");
    await user.click(screen.getByRole("button", { name: /unlock & save/i }));

    await waitFor(() => expect(adapter.unlock).toHaveBeenCalledWith("secret"));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    // Retried automatically — the reviewer never had to click "Add feedback" again.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });
});

// WP21 / defect 2: the composer's position clamp must account for the open
// panel (horizontal) and the composer's own real rendered height
// (vertical) — not a stale 160px guess. jsdom has no layout engine
// (`getBoundingClientRect` returns zeros unless stubbed — see
// `../anchor.test.ts` / `./overlay-root.test.tsx` for the same established
// pattern), so the composer's own box is stubbed here to a realistic size
// and everything else is left at jsdom's zero default.
describe("position clamping at a normal 1280px viewport (WP21)", () => {
  function stubViewport(width: number, height: number) {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("innerHeight", height);
  }

  /** Only `.r3wr-composer` itself (the dialog root) gets a real size; every other div stays at jsdom's zero default, same as an un-stubbed test. */
  function stubComposerBox(width: number, height: number) {
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLDivElement,
    ) {
      const isComposer = this.classList.contains("r3wr-composer");
      const w = isComposer ? width : 0;
      const h = isComposer ? height : 0;
      return { x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h, toJSON() {} };
    });
  }

  it("keeps the composer clear of the open panel for a right-side pin", () => {
    stubViewport(1280, 800);
    // Short box — isolates this test to the HORIZONTAL clamp; the vertical
    // one is covered by the bottom-of-page test below.
    stubComposerBox(336, 300);

    renderComposer({
      anchor: makeAnchor({
        rect: { x: 1000, y: 100, w: 100, h: 40 },
        offsetPct: { x: 0.5, y: 0.5 },
      }),
      panelOpen: true,
    });

    const dialog = screen.getByRole("dialog");
    const left = parseFloat(dialog.style.left);
    const COMPOSER_WIDTH = 336; // min(336, 1280 - 16)
    const PANEL_WIDTH = 384; // .r3wr-panel's docked width: min(384, 0.94 * 1280)

    // The composer's own right edge must land at or before the panel's
    // left edge — never underneath it. Before the fix, this pin's captured
    // position (past the 1280px viewport's horizontal midpoint) put the
    // composer's right edge at 1272px — deep under the panel, which starts
    // at 896px — because the clamp had no idea the panel existed.
    expect(left + COMPOSER_WIDTH).toBeLessThanOrEqual(1280 - PANEL_WIDTH);
    expect(screen.getByRole("button", { name: /add feedback/i })).toBeInTheDocument();
  });

  it("keeps the composer's own bottom edge inside the viewport for a bottom-of-page pin", () => {
    stubViewport(1280, 800);
    // A realistic composer height per the WP21 bug report (category picker
    // + title + comment + name + shot note + actions runs ~450-550px) —
    // more than triple the old flat 160px headroom guess.
    const REALISTIC_HEIGHT = 520;
    stubComposerBox(336, REALISTIC_HEIGHT);

    renderComposer({
      anchor: makeAnchor({
        // Deep down a tall page — well past what any headroom guess smaller
        // than the real content height could safely place on-screen.
        rect: { x: 100, y: 4000, w: 100, h: 40 },
        offsetPct: { x: 0.5, y: 0.5 },
      }),
      panelOpen: true,
    });

    const dialog = screen.getByRole("dialog");
    const top = parseFloat(dialog.style.top);

    // `top + the composer's real height` must stay within the 800px-tall
    // viewport — i.e. "Add feedback" is reachable. The old clamp only
    // guaranteed `top <= innerHeight - 160`; for a 520px-tall composer that
    // put the bottom (submit button included) at up to 1160px — 360px
    // below the bottom of an 800px viewport, with no way to scroll to it.
    expect(top + REALISTIC_HEIGHT).toBeLessThanOrEqual(800);
    expect(screen.getByRole("button", { name: /add feedback/i })).toBeInTheDocument();
  });

  // The panel follows the launcher, so it can sit on either side. The
  // reservation has to move to the bound that matches, and the fixture's
  // `panelOpen: true` default is deliberate — the shut cases are stated
  // explicitly below rather than assumed.
  const COMPOSER_W = 336; // min(336, 1280 - 16)
  const PANEL_W = 384; // .r3wr-panel's docked width: min(384, 0.94 * 1280)

  /** The clamped viewport `left` the composer settled on for `anchor.rect.x`. */
  function leftFor(
    panelOpen: boolean,
    panelSide: ComposerRenderProps["panelSide"],
    pinX: number,
  ): number {
    stubViewport(1280, 800);
    stubComposerBox(COMPOSER_W, 300);
    renderComposer({
      anchor: makeAnchor({ rect: { x: pinX, y: 100, w: 100, h: 40 }, offsetPct: { x: 0.5, y: 0.5 } }),
      panelOpen,
      panelSide,
    });
    return parseFloat(screen.getByRole("dialog").style.left);
  }

  it("reserves the RIGHT edge for a right-docked panel", () => {
    // A pin far right, which without the reservation would put the composer
    // under a right-docked panel.
    const left = leftFor(true, "right", 1000);
    expect(left + COMPOSER_W).toBeLessThanOrEqual(1280 - PANEL_W);
  });

  it("reserves the LEFT edge for a left-docked panel, pushing the composer clear of it", () => {
    // A pin far left. A right-edge reservation would do nothing here — the
    // composer would sit at the 8px margin, squarely under a left-docked
    // panel — so this is the case that catches the reservation being applied
    // to the wrong bound.
    const left = leftFor(true, "left", 20);
    expect(left).toBeGreaterThanOrEqual(PANEL_W);
    // …and pushing it clear must not push it off the other edge.
    expect(left + COMPOSER_W).toBeLessThanOrEqual(1280);
  });

  it("applies neither reservation when the panel is shut", () => {
    // Shut, far-left pin: free to sit beside the pin at the 8px margin,
    // where a left-docked OPEN panel would have pushed it to 384px.
    const shutLeft = leftFor(false, "left", 20);
    expect(shutLeft).toBeLessThan(PANEL_W);
    cleanup();

    // Shut, far-right pin: free to run past where an open right-docked panel
    // would have stopped it (1280 - 384 = 896).
    const shutRight = leftFor(false, "right", 1000);
    expect(shutRight + COMPOSER_W).toBeGreaterThan(1280 - PANEL_W);
    // Still fully on-screen, of course.
    expect(shutRight + COMPOSER_W).toBeLessThanOrEqual(1280 - 8);
  });
});
