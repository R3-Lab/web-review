/**
 * `OverlayRoot` interaction tests (vitest + jsdom + React Testing Library).
 *
 * The reference this package generalizes from (`feedback-overlay-inner.tsx`)
 * has NO tests at all — it was hand-verified in a browser. This is new work,
 * so the bar is real interactions (keyboard, click, selection), not render
 * smoke tests. A fake in-memory `ReviewAdapter` stands in for a consumer's
 * storage; these tests exercise `OverlayRoot`'s render-prop seam in
 * isolation from the real `Composer`/`Panel`/`UnlockDialog`, so wherever a
 * test needs to exercise that seam it supplies a minimal stub component
 * inline — that stub IS the contract the real components satisfy (see
 * `./panels-integration.test.tsx` for the same round trip through the real
 * components instead of stubs).
 *
 * jsdom has no layout engine (`getBoundingClientRect` returns zeros) and no
 * `elementFromPoint` at all — the geometry stubbing below is copied from the
 * established pattern in `../anchor.test.ts`; read that file first if this
 * setup looks unfamiliar.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { OVERLAY_ATTR } from "../anchor";
import { ReviewApiError } from "../core/adapter";
import type { ListThreadsParams } from "../core/adapter";
import { resolveConfig } from "../core/config";
import type { ReviewConfig } from "../core/config";
import type {
  Anchor,
  NewCommentInput,
  NewThreadInput,
  ReviewCommentView,
  ReviewStatus,
  ReviewThreadView,
} from "../core/types";
import { captureScreenshot } from "../client/screenshot";
import { OverlayRoot } from "./overlay-root";
import type { ComposerRenderProps, OverlayRootProps, PanelRenderProps } from "./overlay-root";

// `captureScreenshot` does real rasterization work (dynamic `@zumer/snapdom`
// import, canvas encode) that jsdom can't perform — mocked here so the
// "screenshot lifecycle" tests below can control exactly what
// `beginScreenshot` (`./overlay-root.tsx`) sees a capture resolve to,
// without needing a real DOM layout or canvas backend.
vi.mock("../client/screenshot", () => ({ captureScreenshot: vi.fn() }));

// ─────────────────────────────── DOM stubbing ────────────────────────────────
// jsdom has no layout: getBoundingClientRect returns zeros unless stubbed.

function stubRect(el: Element, rect: { x: number; y: number; w: number; h: number }) {
  el.setAttribute("data-rect", JSON.stringify(rect));
}

/**
 * Force `document.visibilityState`, which jsdom exposes as a read-only getter
 * on `Document.prototype` and never changes on its own. Defined as an own
 * property that shadows the prototype's, so the top-level `afterEach` can
 * hand the real getter back by deleting it.
 */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  if (typeof document.elementFromPoint !== "function") {
    Object.defineProperty(Document.prototype, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => null,
    });
  }
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const raw = this.getAttribute("data-rect");
    const r = raw
      ? (JSON.parse(raw) as { x: number; y: number; w: number; h: number })
      : null;
    const x = r?.x ?? 0;
    const y = r?.y ?? 0;
    const w = r?.w ?? 0;
    const h = r?.h ?? 0;
    return {
      x,
      y,
      width: w,
      height: h,
      top: y,
      left: x,
      right: x + w,
      bottom: y + h,
      toJSON() {},
    };
  });
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  window.localStorage.clear();
  delete (HTMLElement.prototype as unknown as { innerText?: unknown }).innerText;
  delete (Document.prototype as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  // `setVisibility` shadows jsdom's prototype getter with an own property;
  // removing it hands the real one back rather than leaking "hidden" into
  // the next test's refetch listeners.
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

// ────────────────────────────── fake ReviewAdapter ───────────────────────────

function makeAdapter(initial: ReviewThreadView[] = []) {
  const store = [...initial];
  let seq = store.length;

  const listThreads = vi.fn(
    (params: ListThreadsParams): Promise<ReviewThreadView[]> =>
      Promise.resolve(
        store.filter(
          (t) =>
            (!params.urlKey || t.urlKey === params.urlKey) &&
            (!params.status || params.status === "all" || t.status === params.status),
        ),
      ),
  );

  const getThread = vi.fn((id: string): Promise<ReviewThreadView> => {
    const t = store.find((row) => row.id === id);
    if (!t) return Promise.reject(new ReviewApiError(404, "not found"));
    return Promise.resolve(t);
  });

  const createThread = vi.fn(async (input: NewThreadInput): Promise<ReviewThreadView> => {
    await Promise.resolve();
    seq += 1;
    const now = new Date().toISOString();
    const comment: ReviewCommentView = {
      id: `c${seq}`,
      threadId: `t${seq}`,
      body: input.firstComment,
      authorId: input.authorId,
      authorName: input.authorName,
      createdAt: now,
    };
    const thread: ReviewThreadView = {
      id: `t${seq}`,
      project: input.project ?? "web",
      url: input.url,
      urlKey: input.urlKey,
      locale: input.locale,
      route: input.route ?? null,
      title: input.title ?? null,
      category: input.category,
      anchor: input.anchor,
      viewport: input.viewport ?? null,
      status: "open",
      authorId: input.authorId,
      authorName: input.authorName,
      screenshotUrl: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolvedBy: null,
      comments: [comment],
      commentCount: 1,
    };
    store.push(thread);
    return thread;
  });

  const addComment = vi.fn(
    async (threadId: string, input: NewCommentInput): Promise<ReviewCommentView> => {
      await Promise.resolve();
      const t = store.find((row) => row.id === threadId);
      if (!t) throw new ReviewApiError(404, "not found");
      seq += 1;
      const comment: ReviewCommentView = {
        id: `c${seq}`,
        threadId,
        body: input.body,
        authorId: input.authorId,
        authorName: input.authorName,
        createdAt: new Date().toISOString(),
      };
      t.comments.push(comment);
      t.commentCount += 1;
      return comment;
    },
  );

  const setStatus = vi.fn(
    async (
      threadId: string,
      status: ReviewStatus,
      resolvedBy?: string | null,
    ): Promise<ReviewThreadView> => {
      await Promise.resolve();
      const t = store.find((row) => row.id === threadId);
      if (!t) throw new ReviewApiError(404, "not found");
      t.status = status;
      t.resolvedAt = status === "resolved" ? new Date().toISOString() : null;
      t.resolvedBy = status === "resolved" ? (resolvedBy ?? null) : null;
      return t;
    },
  );

  return { listThreads, getThread, createThread, addComment, setStatus };
}

// ──────────────────────────────── fixtures ───────────────────────────────────

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
    highlightRectsPct: [{ x: 0, y: 0, w: 1, h: 1 }],
    ...overrides,
  };
}

let threadSeq = 0;
function makeThread(
  overrides: Omit<Partial<ReviewThreadView>, "anchor"> & { anchor?: Partial<Anchor> } = {},
): ReviewThreadView {
  threadSeq += 1;
  const anchor = makeAnchor(overrides.anchor);
  const now = new Date().toISOString();
  return {
    id: `t${threadSeq}`,
    project: "web",
    url: anchor.href,
    urlKey: anchor.urlKey,
    locale: null,
    route: "/",
    title: "Sample thread",
    category: "design",
    viewport: anchor.viewport,
    status: "open",
    authorId: "u1",
    authorName: "Reviewer",
    screenshotUrl: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedBy: null,
    comments: [],
    commentCount: 0,
    ...overrides,
    anchor,
  };
}

function renderOverlay(config: ReviewConfig, extraProps: Partial<Omit<OverlayRootProps, "config">> = {}) {
  return render(<OverlayRoot config={resolveConfig(config)} {...extraProps} />);
}

// ────────────────────────────────── tests ────────────────────────────────────

describe("thread loading + pin rendering", () => {
  it("fetches threads for the current urlKey and renders a pin per thread", async () => {
    const thread = makeThread({ urlKey: "/" });
    const adapter = makeAdapter([thread]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review pin 1/i });
    expect(adapter.listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ urlKey: "/", status: "all" }),
    );
  });

  // `OverlayRoot`'s side of the anchor-placement contract: it resolves every
  // thread's anchor once per render and hands the result to `Pin`, so a
  // thread whose anchor binds to nothing on this page still gets a pin —
  // silently dropping someone's comment is the one outcome that is never
  // acceptable. Which badge that pin wears is `./pin.test.tsx`'s subject (and
  // the classification itself is `./helpers.test.ts`'s); what is asserted
  // here is that the resolution reaches the pin at all, and that the state it
  // arrives in is the honest one for this fixture.
  //
  // The fixture resolves to NO candidate whatsoever — a selector matching
  // nothing and a text hint resembling nothing — which is "unplaceable", not
  // "drifted". The two were one boolean until `anchorPlacement` split them,
  // and this test asserted `data-drifted` back when that name covered both.
  // Keeping that assertion now would have the overlay tell a reviewer their
  // page changed on the strength of evidence that says only "not found here".
  it("renders a pin for a thread whose anchor binds to nothing, badged as unplaceable", async () => {
    const thread = makeThread({
      anchor: {
        selector: "#does-not-exist-anywhere",
        textHint: "Nothing on this page resembles this text at all",
        tagName: "div",
      },
    });
    const adapter = makeAdapter([thread]);
    renderOverlay({ adapter });

    const pin = await screen.findByRole("button", { name: /review pin 1/i });
    expect(pin).toHaveAttribute("data-unplaceable", "true");
    // And specifically NOT drift: nothing here supports the claim that the
    // page changed, so the overlay must not make it.
    expect(pin).toHaveAttribute("data-drifted", "false");
    expect(pin).toHaveAccessibleName(/anchor not found on this page/i);
    expect(pin).not.toHaveAccessibleName(/drifted/i);
  });
});

describe("pin-drop mode", () => {
  it("enters pin-drop mode on 'c' and captures an element anchor with a plausible selector", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let captured: Anchor | undefined;

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          captured = props.anchor;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await screen.findByText(/select words to pin the copy/i);

    await user.click(target);

    await waitFor(() => expect(captured).toBeDefined());
    expect(captured?.kind).toBe("element");
    expect(captured?.selector).toContain('data-testid="widget"');
  });

  it("captures a text-kind anchor carrying the selected words", async () => {
    const para = document.createElement("p");
    para.id = "para";
    para.textContent = "Highlight this sentence please";
    document.body.appendChild(para);
    stubRect(para, { x: 0, y: 0, w: 400, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(para);

    // A live, non-collapsed selection whose common ancestor is `para` — see
    // `../anchor.test.ts` for why a fake Selection is used rather than a
    // real jsdom Range (jsdom's Range/Selection geometry support is limited).
    const range = {
      commonAncestorContainer: para,
      getClientRects: () =>
        [{ left: 0, top: 0, width: 200, height: 20 }] as unknown as DOMRectList,
    } as unknown as Range;
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => "Highlight this sentence",
    } as unknown as Selection);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let captured: Anchor | undefined;

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          captured = props.anchor;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(para);

    await waitFor(() => expect(captured).toBeDefined());
    expect(captured?.kind).toBe("text");
    expect(captured?.selectedText).toBe("Highlight this sentence");
  });

  it("does not drop a pin when clicking the overlay's own chrome", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let captured: Anchor | undefined;

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          captured = props.anchor;
          return null;
        },
        renderPanel: () => <div data-testid="panel" />,
      },
    );

    const launcher = await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await screen.findByText(/select words to pin the copy/i);

    await user.click(launcher);

    expect(captured).toBeUndefined();
    // The launcher's own click handler still ran (the panel opened) — proof
    // the click reached the button rather than being silently eaten by the
    // capture handler.
    expect(await screen.findByTestId("panel")).toBeInTheDocument();
  });

  it("does not drop a pin when clicking an editable target", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    stubRect(input, { x: 0, y: 0, w: 100, h: 30 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(input);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let captured: Anchor | undefined;

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          captured = props.anchor;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(input);

    expect(captured).toBeUndefined();
  });

  it("creates a thread via the composer seam, merges it into state, and selects it", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();

    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => (
          <button
            type="button"
            onClick={() =>
              void props.onSubmit({
                category: "bug",
                title: "A bug",
                body: "It broke",
                name: "Ada",
              })
            }
          >
            submit draft
          </button>
        ),
      },
    );

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);
    const submit = await screen.findByRole("button", { name: /submit draft/i });
    await user.click(submit);

    await screen.findByRole("button", { name: /review pin 1/i });
    expect(adapter.createThread).toHaveBeenCalledTimes(1);
    expect(adapter.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "bug",
        title: "A bug",
        firstComment: "It broke",
        authorName: "Ada",
      }),
    );
  });
});

// The bug these cover: the launcher used to call `enterPinDropMode`, so
// pressing it both opened the panel AND armed picking — a reviewer who only
// wanted to read existing feedback got a crosshair cursor and a capture scrim
// over the page. The launcher now opens the panel and nothing else, and the
// `c` shortcut arms picking and nothing else.
describe("launcher ⇄ panel decoupling", () => {
  /**
   * A mutable box a render-prop stub publishes its payload into, so a test
   * can assert on values that have no DOM of their own (`panelSide`,
   * `pinDropMode`, `onTogglePinDrop`). A plain `let` would do, except that
   * TypeScript narrows a `let` only ever assigned inside a callback, which
   * would put a cast on every read.
   */
  interface Payload<T> {
    current: T | null;
  }

  /** A panel stub that both renders something findable and records its payload. */
  function capturePanel(sink: Payload<PanelRenderProps>) {
    return (props: PanelRenderProps) => {
      sink.current = props;
      return <div data-testid="panel" />;
    };
  }

  /** Pin-drop mode's two visible tells: the capture scrim and the hint strip. */
  function pickingChromeCount() {
    return document.querySelectorAll(".r3wr-capture, .r3wr-capture-hint").length;
  }

  it("opens the panel on launcher activation and leaves pin-drop mode disarmed", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    const panel: Payload<PanelRenderProps> = { current: null };
    renderOverlay({ adapter }, { renderPanel: capturePanel(panel) });

    await user.click(await screen.findByRole("button", { name: "Open the review panel" }));

    expect(await screen.findByTestId("panel")).toBeInTheDocument();
    expect(panel.current?.pinDropMode).toBe(false);
    expect(pickingChromeCount()).toBe(0);
  });

  it("closes the panel when the launcher is activated again", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    await user.click(launcher);
    await screen.findByTestId("panel");

    await user.click(launcher);
    await waitFor(() => expect(screen.queryByTestId("panel")).toBeNull());
  });

  it("arms pin-drop mode on 'c' without opening the panel", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    await screen.findByRole("button", { name: "Open the review panel" });
    await user.keyboard("c");

    await screen.findByText(/select words to pin the copy/i);
    expect(screen.queryByTestId("panel")).toBeNull();
    // And the launcher still offers to OPEN the panel — arming picking has
    // not touched what that button is for.
    expect(screen.getByRole("button", { name: "Open the review panel" })).toBeInTheDocument();
  });

  it("arms and disarms pin-drop mode through the panel's onTogglePinDrop", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    const panel: Payload<PanelRenderProps> = { current: null };
    renderOverlay({ adapter }, { renderPanel: capturePanel(panel) });

    await user.click(await screen.findByRole("button", { name: "Open the review panel" }));
    await screen.findByTestId("panel");

    act(() => panel.current?.onTogglePinDrop());
    await screen.findByText(/select words to pin the copy/i);
    expect(panel.current?.pinDropMode).toBe(true);

    act(() => panel.current?.onTogglePinDrop());
    await waitFor(() => expect(pickingChromeCount()).toBe(0));
    expect(panel.current?.pinDropMode).toBe(false);
    // Disarming picking is not closing the panel — they are separate axes in
    // both directions.
    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });

  it("renders a composer with the panel shut, since pin-drop mode no longer opens it", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    const composer: Payload<ComposerRenderProps> = { current: null };
    renderOverlay(
      { adapter },
      {
        renderPanel: () => <div data-testid="panel" />,
        renderComposer: (props) => {
          composer.current = props;
          return null;
        },
      },
    );

    await screen.findByRole("button", { name: "Open the review panel" });
    await user.keyboard("c");
    await user.click(target);

    await waitFor(() => expect(composer.current).not.toBeNull());
    expect(composer.current?.panelOpen).toBe(false);
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("names the launcher for what it does, carrying the open-thread count while shut", async () => {
    const adapter = makeAdapter([makeThread({ urlKey: "/" }), makeThread({ urlKey: "/" })]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    const launcher = await screen.findByRole("button", {
      name: "Open the review panel. 2 open on this page",
    });
    await user.click(launcher);

    // Same node, renamed: the count goes away because the panel it counts is
    // now on screen, and the action on offer is the opposite one.
    expect(await screen.findByRole("button", { name: "Close the review panel" })).toBe(launcher);
  });

  it("drops the count from the launcher's name when nothing is open on this page", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    expect(await screen.findByRole("button", { name: "Open the review panel" })).toBeInTheDocument();
  });
});

describe("launcher docking", () => {
  /**
   * jsdom reports no layout at all, so the launcher's box and the viewport
   * both have to be stated outright — every coordinate in the drag below is
   * derived from these two. The values match jsdom's own defaults, so there
   * is nothing for a later test to inherit.
   */
  function setViewport(width: number, height: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  }

  it("docks the panel to the side that keeps it clear of the launcher, in both payloads", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    let panelSide: string | undefined;
    let composerSide: string | undefined;
    renderOverlay(
      { adapter },
      {
        renderPanel: (props) => {
          panelSide = props.panelSide;
          return <div data-testid="panel" />;
        },
        renderComposer: (props) => {
          composerSide = props.panelSide;
          return null;
        },
      },
    );

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    await user.click(launcher);
    await screen.findByTestId("panel");

    // The launcher starts on the right edge, so the panel stays where it has
    // always been — this is "move the panel only when staying put would hide
    // the launcher", not "mirror the launcher".
    expect(panelSide).toBe("right");
    expect(document.querySelector(".r3wr-root")).toHaveAttribute("data-panel-side", "right");

    // Arrow keys are the launcher's non-drag docking path (WCAG 2.5.7), and
    // they need no geometry — the honest way to move it in a DOM with no
    // layout engine.
    launcher.focus();
    await user.keyboard("{ArrowLeft}");

    await waitFor(() => expect(panelSide).toBe("left"));
    expect(launcher).toHaveAttribute("data-edge", "left");
    expect(document.querySelector(".r3wr-root")).toHaveAttribute("data-panel-side", "left");

    // And the same side reaches a composer, which clamps itself against it.
    await user.keyboard("c");
    await user.click(target);
    await waitFor(() => expect(composerSide).toBe("left"));
  });

  // WP9: the panel is an obstacle to the launcher, not just a state of it.
  // Both dock to a viewport edge, so an open panel can end up underneath the
  // pill — and in the shipped default (launcher bottom-right, panel right) it
  // did, over the panel's own keyboard-shortcuts strip. The fix has two
  // halves; this suite covers `OverlayRoot`'s obligation to both.
  it("hands the launcher the open panel's dock, and takes it back when the panel shuts", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    setViewport(1440, 900);
    stubRect(launcher, { x: 0, y: 0, w: 132, h: 44 });

    // The bottom edge is where a dock actually constrains the launcher: the
    // panel is full-height, so a pill travelling a HORIZONTAL edge is the one
    // that can slide into its column. Arrow keys are the geometry-free way to
    // get it there (WCAG 2.5.7's non-drag path, reused here as a test seam).
    launcher.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(launcher).toHaveAttribute("data-edge", "bottom"));

    // Panel shut: the far end of the 1440 - 132 = 1308px track, one 18px
    // margin in. Nothing to avoid, so nothing is given up.
    expect(launcher.style.getPropertyValue("--r3wr-launcher-pos")).toBe("1290px");

    await user.click(launcher);
    await screen.findByTestId("panel");

    // Panel open: the right-docked panel's 384px column comes off that same
    // end, leaving the pill's right edge one margin clear of it.
    await waitFor(() =>
      expect(launcher.style.getPropertyValue("--r3wr-launcher-pos")).toBe("906px"),
    );

    // And back again — the clamp is tied to the panel being up, not to
    // anything the launcher remembers.
    await user.click(launcher);
    await waitFor(() => expect(screen.queryByTestId("panel")).toBeNull());
    expect(launcher.style.getPropertyValue("--r3wr-launcher-pos")).toBe("1290px");
  });

  // The other half of WP9 is a pair of `overlay.css` rules: a launcher docked
  // to the SAME side as the panel is stepped inboard by the panel's width, on
  // an inset no JS value here carries. A DOM test cannot prove that offset —
  // jsdom applies no stylesheet — so what it proves instead is that the live
  // DOM really does match the selector those rules are written against. The
  // offset itself is verified visually, in `docs/images/`.
  it("carries exactly the attributes the stylesheet's same-edge step-inboard keys on", async () => {
    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: () => <div data-testid="panel" /> });

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    const root = document.querySelector(".r3wr-root");

    // Shut, so the rules must not match — `data-panel-open` is the term that
    // says so, and it has to be present-and-false rather than absent.
    expect(root).toHaveAttribute("data-panel-open", "false");

    await user.click(launcher);
    await screen.findByTestId("panel");

    // Open, in the default arrangement: launcher on the right edge, panel
    // docked right, no drag in flight.
    expect(
      document.querySelector(
        '.r3wr-root[data-panel-open="true"][data-panel-side="right"] .r3wr-toggle[data-edge="right"]:not([data-dragging])',
      ),
    ).toBe(launcher);

    // The mirror rule, for a launcher a reviewer has moved to the left edge —
    // which takes the panel with it (`panelSideForEdge`), so the two collide
    // there too.
    launcher.focus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(root).toHaveAttribute("data-panel-side", "left"),
    );
    expect(
      document.querySelector(
        '.r3wr-root[data-panel-open="true"][data-panel-side="left"] .r3wr-toggle[data-edge="left"]:not([data-dragging])',
      ),
    ).toBe(launcher);
  });

  it("persists the docked position under the configured prefix and restores it on remount", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter, storagePrefix: "acme" });

    const launcher = await screen.findByRole("button", { name: "Open the review panel" });
    setViewport(1024, 768);
    // The suite's stubbed `getBoundingClientRect` reads `data-rect`, so this
    // is how the pill gets a box worth snapping from.
    stubRect(launcher, { x: 950, y: 700, w: 132, h: 44 });

    // Grabbed 10px in and 20px down from the pill's top-left and released
    // with that box at (30, 380) — centre (96, 402), nearest the left edge,
    // 402/768 of the way down it.
    fireEvent.pointerDown(launcher, { pointerId: 1, button: 0, clientX: 960, clientY: 720 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 40, clientY: 400 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 400 });
    // The browser fires a click after the release; delivering it is what
    // exercises (and clears) the launcher's one-shot suppression of it.
    fireEvent.click(launcher);

    await waitFor(() =>
      expect(window.localStorage.getItem("acme.launcher")).toBe(
        JSON.stringify({ edge: "left", offset: 402 / 768 }),
      ),
    );
    // Letting go of the launcher must not also press it.
    expect(screen.getByRole("button", { name: "Open the review panel" })).toBeInTheDocument();
    cleanup();

    renderOverlay({ adapter, storagePrefix: "acme" });
    expect(await screen.findByRole("button", { name: "Open the review panel" })).toHaveAttribute(
      "data-edge",
      "left",
    );
  });
});

describe("highlight visibility", () => {
  it("persists the toggle to localStorage under the configured prefix and honours it on remount", async () => {
    const adapter = makeAdapter([]);
    const renderPanel = (props: PanelRenderProps) => (
      <button type="button" onClick={props.onToggleHighlights}>
        highlights: {props.showHighlights ? "on" : "off"}
      </button>
    );

    const firstUser = userEvent.setup();
    renderOverlay({ adapter, storagePrefix: "acme" }, { renderPanel });
    // The launcher only appears once the gate reaches "unlocked", so finding
    // it is also the wait — and pressing it is how a reviewer opens the panel
    // now that the launcher does that and nothing else.
    await firstUser.click(await screen.findByRole("button", { name: /review panel/i }));
    const toggle = await screen.findByRole("button", { name: /highlights: on/i });
    await firstUser.click(toggle);
    await screen.findByRole("button", { name: /highlights: off/i });
    expect(window.localStorage.getItem("acme.showHighlights")).toBe("0");
    cleanup();

    const secondUser = userEvent.setup();
    renderOverlay({ adapter, storagePrefix: "acme" }, { renderPanel });
    await secondUser.click(await screen.findByRole("button", { name: /review panel/i }));
    expect(await screen.findByRole("button", { name: /highlights: off/i })).toBeInTheDocument();
  });
});

/**
 * The pins switch: the persistent half of a reviewer's escape from a marker
 * sitting on something they need to click. (The momentary half is the held
 * key, further down.)
 *
 * Every case here is asserted against BOTH layers, because the whole reason
 * pins got a switch of their own is that hiding highlights was never an
 * acceptable price for getting a click through. A test that only looked at
 * the layer it was turning off would pass just as happily if the two were
 * wired to one flag again.
 */
describe("pin visibility", () => {
  /** A panel stub exposing both switches, and both current values, as findable controls. */
  function visibilityPanel(props: PanelRenderProps) {
    return (
      <div>
        <button type="button" onClick={props.onToggleShowPins}>
          pins: {props.showPins ? "on" : "off"}
        </button>
        <button type="button" onClick={props.onToggleHighlights}>
          highlights: {props.showHighlights ? "on" : "off"}
        </button>
      </div>
    );
  }

  /** The markers themselves — not the panel's rows, and not the draft marker. */
  function pinCount() {
    return document.querySelectorAll(".r3wr-pin").length;
  }

  function highlightCount() {
    return document.querySelectorAll(".r3wr-highlight").length;
  }

  /** Renders with one thread on this page and the panel already open. */
  async function openWithOnePin(storagePrefix = "acme") {
    const adapter = makeAdapter([makeThread({ urlKey: "/" })]);
    const user = userEvent.setup();
    renderOverlay({ adapter, storagePrefix }, { renderPanel: visibilityPanel });
    await user.click(await screen.findByRole("button", { name: /review panel/i }));
    return user;
  }

  it("draws both layers by default", async () => {
    await openWithOnePin();
    await waitFor(() => expect(pinCount()).toBe(1));
    expect(highlightCount()).toBe(1);
  });

  it("removes every pin from the document when switched off, and keeps the highlights", async () => {
    const user = await openWithOnePin();
    await waitFor(() => expect(pinCount()).toBe(1));

    await user.click(await screen.findByRole("button", { name: /pins: on/i }));

    // Gone from the DOM, not merely invisible: an element that is still there
    // is still something that can intercept a click.
    await waitFor(() => expect(pinCount()).toBe(0));
    expect(screen.queryByRole("button", { name: /review pin 1/i })).toBeNull();
    expect(highlightCount()).toBe(1);
  });

  it("keeps the pins when the highlights are switched off instead", async () => {
    const user = await openWithOnePin();
    await waitFor(() => expect(highlightCount()).toBe(1));

    await user.click(await screen.findByRole("button", { name: /highlights: on/i }));

    await waitFor(() => expect(highlightCount()).toBe(0));
    expect(pinCount()).toBe(1);
  });

  it("persists the choice under the configured prefix and honours it on remount", async () => {
    const user = await openWithOnePin();
    await user.click(await screen.findByRole("button", { name: /pins: on/i }));
    await screen.findByRole("button", { name: /pins: off/i });
    expect(window.localStorage.getItem("acme.showPins")).toBe("0");
    // The other switch is untouched on disk too, not just on screen.
    expect(window.localStorage.getItem("acme.showHighlights")).toBeNull();
    cleanup();

    const secondUser = userEvent.setup();
    const adapter = makeAdapter([makeThread({ urlKey: "/" })]);
    renderOverlay({ adapter, storagePrefix: "acme" }, { renderPanel: visibilityPanel });
    await secondUser.click(await screen.findByRole("button", { name: /review panel/i }));
    expect(await screen.findByRole("button", { name: /pins: off/i })).toBeInTheDocument();
    expect(pinCount()).toBe(0);
  });

  // Turning the markers off is how a reviewer unblocks a page they still want
  // to work on. If it also took away their ability to leave the next comment,
  // it would just be a different way of switching the tool off.
  it("still drops a pin with the pins hidden — mode, draft marker and composer all intact", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "widget");
    target.textContent = "A page element";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 200, h: 60 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const user = await openWithOnePin();
    await user.click(await screen.findByRole("button", { name: /pins: on/i }));
    await waitFor(() => expect(pinCount()).toBe(0));

    await user.keyboard("c");
    await screen.findByText(/select words to pin the copy/i);
    await user.click(target);

    // The draft marker is not one of the pins that were hidden — it is the
    // only thing telling the reviewer what they are about to comment on.
    await waitFor(() => expect(document.querySelectorAll(".r3wr-pin-draft")).toHaveLength(1));
    // And the existing markers are still hidden, so the escape survived the
    // round trip rather than being quietly undone by entering pin-drop mode.
    expect(pinCount()).toBe(0);
  });
});

/**
 * The held pass-through key: the momentary twin of the pins switch, for a
 * reviewer who wants one click through and their markers straight back.
 *
 * `data-passthrough` on the pin layer is the whole of the state — the
 * stylesheet turns it into "nothing in this layer catches a pointer" — so
 * these tests read it directly rather than trying to measure hit-testing,
 * which jsdom cannot do. `examples/next-demo/e2e/pin-passthrough.spec.ts`
 * covers the half that needs a real browser: that a link under a pin actually
 * receives the click.
 */
describe("the pass-through hold key", () => {
  /** `"true"` / `"false"` — the pin layer's own report of the state. */
  function passThrough(): string | null {
    return document.querySelector(".r3wr-pin-layer")?.getAttribute("data-passthrough") ?? null;
  }

  /** Dispatches a real key event at the window and hands it back, so `defaultPrevented` is readable. */
  function sendKey(type: "keydown" | "keyup", init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  }

  const HOLD = { key: "h", code: "KeyH" } as const;

  async function mounted() {
    const adapter = makeAdapter([makeThread({ urlKey: "/" })]);
    renderOverlay({ adapter });
    await screen.findByRole("button", { name: /review panel/i });
  }

  it("is off until the key goes down, and on for exactly as long as it is held", async () => {
    await mounted();
    expect(passThrough()).toBe("false");

    sendKey("keydown", HOLD);
    expect(passThrough()).toBe("true");

    sendKey("keyup", HOLD);
    expect(passThrough()).toBe("false");
  });

  // Observed, never consumed. A bare key the overlay swallows is a key the
  // host page and the browser no longer get.
  it("never calls preventDefault on the key, unlike the 'c' shortcut", async () => {
    await mounted();
    expect(sendKey("keydown", HOLD).defaultPrevented).toBe(false);
    expect(sendKey("keyup", HOLD).defaultPrevented).toBe(false);
    // The contrast is the point: `c` is a shortcut this overlay owns and does
    // consume, so "we did not call preventDefault" is a real choice here
    // rather than something no handler in this file ever does.
    expect(sendKey("keydown", { key: "c", code: "KeyC" }).defaultPrevented).toBe(true);
  });

  // The stranding case. Hold the key, alt-tab away, and the keyup lands in
  // another window: without this the layer would stay click-through forever,
  // with no visible cause and no way back short of a reload.
  it("releases when the window loses focus while the key is held", async () => {
    await mounted();
    sendKey("keydown", HOLD);
    expect(passThrough()).toBe("true");

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(passThrough()).toBe("false");
  });

  it("releases when the tab is hidden while the key is held", async () => {
    await mounted();
    sendKey("keydown", HOLD);

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(passThrough()).toBe("false");
  });

  it("stays released after a stranding event, until the key is pressed again", async () => {
    await mounted();
    sendKey("keydown", HOLD);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    // The keyup that never arrived, arriving late: it must not toggle
    // anything back on.
    sendKey("keyup", HOLD);
    expect(passThrough()).toBe("false");

    sendKey("keydown", HOLD);
    expect(passThrough()).toBe("true");
  });

  it("ignores the key while a text field has focus", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    await mounted();
    input.focus();

    sendKey("keydown", HOLD);
    // A reviewer typing "h" into a form on the page under review must not
    // have that page silently change behaviour under them.
    expect(passThrough()).toBe("false");
  });

  it("ignores the key when it is modified, so host and browser chords stay whole", async () => {
    await mounted();
    sendKey("keydown", { ...HOLD, ctrlKey: true });
    expect(passThrough()).toBe("false");
    sendKey("keydown", { ...HOLD, metaKey: true });
    expect(passThrough()).toBe("false");
    sendKey("keydown", { ...HOLD, altKey: true });
    expect(passThrough()).toBe("false");
  });

  // Two ways to recognise the same physical key, and the release path accepts
  // either — see `PASS_THROUGH_KEY`'s comment. macOS turns Option+h into "˙",
  // so a keyup matched on the character alone would strand the state the
  // moment a modifier joined a hold already in progress.
  it("releases on a keyup whose character no longer reads as the key, by physical code", async () => {
    await mounted();
    sendKey("keydown", HOLD);
    sendKey("keyup", { key: "˙", code: "KeyH", altKey: true });
    expect(passThrough()).toBe("false");
  });

  it("arms on a keydown whose character is the key on a remapped layout", async () => {
    await mounted();
    sendKey("keydown", { key: "h", code: "KeyD" });
    expect(passThrough()).toBe("true");
  });

  it("ignores any other key entirely", async () => {
    await mounted();
    sendKey("keydown", { key: "g", code: "KeyG" });
    expect(passThrough()).toBe("false");
  });
});

/**
 * The number behind the panel's "N pins couldn't be placed" line.
 *
 * These build the three anchor states out of REAL `resolveAnchor` runs
 * against a real (jsdom) document rather than handing the panel a rigged
 * number — the count's whole job is to agree with the badges on the pins
 * beside it, and a fixture that skipped the resolver could not show that.
 * Each case therefore asserts the premise (`data-unplaceable` /
 * `data-drifted` on the pin the fixture was built to produce) alongside the
 * count, so a scoring change that moved a fixture out of its intended state
 * fails as a broken premise instead of silently proving nothing.
 */
describe("the unplaceable-pins count", () => {
  /** A panel stub that publishes the count into `sink`. */
  function countingPanel(sink: { current: number | null }) {
    return (props: PanelRenderProps) => {
      sink.current = props.unplaceableCount;
      return <div data-testid="panel" />;
    };
  }

  /** An anchor nothing on the page resembles — no candidate at all, so: unplaceable. */
  function unplaceableAnchor(): Partial<Anchor> {
    return {
      selector: "#does-not-exist-anywhere",
      textHint: "Nothing on this page resembles this text at all",
      tagName: "div",
    };
  }

  /**
   * An anchor captured on a `<p>` that has since been re-worded, re-classed
   * and re-nested — the scorer still recognises it through the surviving
   * words, but not well enough to trust: drifted. Mirrors the fixture in
   * `./helpers.test.ts`, including the nesting, which is what keeps the
   * ancestor-path term from pushing the score back over the threshold.
   */
  function driftedAnchor(): Partial<Anchor> {
    return {
      selector: "#old-id",
      textHint: "Pricing now starts at ten dollars a month",
      tagName: "p",
      classes: ["lede"],
      ancestorPath: [
        { tag: "div", idxOfType: 1 },
        { tag: "body", idxOfType: 1 },
      ],
    };
  }

  /** Puts the re-worded paragraph `driftedAnchor` half-matches into the page. */
  function renderEditedParagraph() {
    const host = document.createElement("main");
    host.innerHTML =
      '<section><p id="new-id" class="intro">Pricing now starts at twenty dollars a month</p></section>';
    document.body.appendChild(host);
  }

  /** Puts the exact element `makeAnchor`'s default selector binds to into the page. */
  function renderExactTarget() {
    const el = document.createElement("div");
    el.id = "target";
    el.textContent = "Target";
    document.body.appendChild(el);
  }

  async function countFor(threads: ReviewThreadView[]): Promise<{ current: number | null }> {
    const sink: { current: number | null } = { current: null };
    const adapter = makeAdapter(threads);
    const user = userEvent.setup();
    renderOverlay({ adapter }, { renderPanel: countingPanel(sink) });
    await user.click(await screen.findByRole("button", { name: /review panel/i }));
    await screen.findByTestId("panel");
    return sink;
  }

  it("is zero when every anchor still binds", async () => {
    renderExactTarget();
    const sink = await countFor([makeThread({ urlKey: "/" })]);

    const pin = await screen.findByRole("button", { name: /review pin 1/i });
    expect(pin).toHaveAttribute("data-unplaceable", "false");
    expect(pin).toHaveAttribute("data-drifted", "false");
    expect(sink.current).toBe(0);
  });

  it("counts the anchors that bound to nothing", async () => {
    const sink = await countFor([
      makeThread({ urlKey: "/", anchor: unplaceableAnchor() }),
      makeThread({ urlKey: "/", anchor: unplaceableAnchor() }),
    ]);

    await waitFor(() => expect(screen.getAllByRole("button", { name: /review pin/i })).toHaveLength(2));
    for (const pin of screen.getAllByRole("button", { name: /review pin/i })) {
      expect(pin).toHaveAttribute("data-unplaceable", "true");
    }
    expect(sink.current).toBe(2);
  });

  // The separation this whole count rests on. "We matched something weakly"
  // and "we found nothing" are different findings with different copy, and
  // one number covering both would put the conflation back.
  it("never counts a drifted anchor, even alongside an unplaceable one", async () => {
    renderEditedParagraph();
    const sink = await countFor([
      makeThread({ urlKey: "/", title: "Drifted", anchor: driftedAnchor() }),
      makeThread({ urlKey: "/", title: "Not found", anchor: unplaceableAnchor() }),
    ]);

    const drifted = await screen.findByRole("button", { name: /review pin 1/i });
    const notFound = await screen.findByRole("button", { name: /review pin 2/i });
    // The premise, asserted rather than assumed.
    expect(drifted).toHaveAttribute("data-drifted", "true");
    expect(drifted).toHaveAttribute("data-unplaceable", "false");
    expect(notFound).toHaveAttribute("data-unplaceable", "true");

    expect(sink.current).toBe(1);
  });

  it("is zero when the only unbound anchors are drifted ones", async () => {
    renderEditedParagraph();
    const sink = await countFor([makeThread({ urlKey: "/", anchor: driftedAnchor() })]);

    expect(await screen.findByRole("button", { name: /review pin 1/i })).toHaveAttribute(
      "data-drifted",
      "true",
    );
    expect(sink.current).toBe(0);
  });

  // The count describes the pins actually on screen, so it has to move with
  // the filter that decides which those are — a summary counting rows the
  // reviewer has filtered away is a number they cannot reconcile with
  // anything they can see.
  it("follows the filter, counting only the threads being drawn", async () => {
    const sink = await countFor([
      makeThread({ urlKey: "/", status: "open", anchor: unplaceableAnchor() }),
      makeThread({ urlKey: "/", status: "resolved", anchor: unplaceableAnchor() }),
    ]);

    // The default filter is "open", so one of the two is drawn.
    await waitFor(() => expect(sink.current).toBe(1));
  });
});

describe("gate", () => {
  it("unmounts entirely when the adapter reports the feature disabled (404 feature_disabled)", async () => {
    const adapter = makeAdapter([]);
    adapter.listThreads = vi.fn(() => {
      throw new ReviewApiError(404, "disabled", "feature_disabled");
    });

    const { container } = renderOverlay({ adapter });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(document.body.querySelector(`[${OVERLAY_ATTR}]`)).toBeNull();
  });

  // Regression: a 404 for an unrelated reason (e.g. an unknown thread
  // id, coded `not_found`) must NOT be mistaken for the feature being
  // switched off — `isFeatureDisabled` only recognizes `feature_disabled`.
  // The probe fails soft here (see `OverlayRoot`'s `probe` callback), so the
  // overlay stays mounted rather than tearing itself down over an
  // unrelated, likely transient, 404.
  it("does NOT unmount for a 404 carrying an unrelated code (e.g. not_found)", async () => {
    const adapter = makeAdapter([]);
    adapter.listThreads = vi.fn(() => {
      throw new ReviewApiError(404, "missing", "not_found");
    });

    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    expect(document.body.querySelector(`[${OVERLAY_ATTR}]`)).not.toBeNull();
  });
});

// A single-page app changes the URL without unmounting the overlay, so the
// thread list outlives the page it was fetched for unless something says
// otherwise. These cover both halves of that: the previous page's pins must
// stop rendering the moment the URL changes, and a request for a page the
// reviewer has left must never overwrite the page they are on.
describe("page scoping", () => {
  /** Everything here navigates; jsdom keeps the URL between tests. */
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  /** The pin buttons currently drawn on the page, by structure rather than by label. */
  function renderedPins() {
    return document.querySelectorAll(".r3wr-pin-layer button");
  }

  /**
   * An adapter whose `listThreads` parks every call instead of resolving it,
   * so a test can choose the order two in-flight requests come back in —
   * which is the entire subject of the stale-write tests below.
   */
  function makeDeferredAdapter() {
    const pending: Array<{ urlKey: string; resolve: (list: ReviewThreadView[]) => void }> = [];
    return {
      ...makeAdapter([]),
      pending,
      listThreads: vi.fn(
        (params: ListThreadsParams) =>
          new Promise<ReviewThreadView[]>((resolve) => {
            pending.push({ urlKey: params.urlKey ?? "", resolve });
          }),
      ),
    };
  }

  it("stops rendering the previous page's pins as soon as the URL changes", async () => {
    const adapter = makeDeferredAdapter();
    const panel: { current: PanelRenderProps | null } = { current: null };
    renderOverlay({ adapter }, { renderPanel: (props) => ((panel.current = props), null) });

    await waitFor(() => expect(adapter.pending).toHaveLength(1));
    await act(async () => {
      adapter.pending[0]?.resolve([makeThread({ urlKey: "/", title: "Home thread" })]);
      await Promise.resolve();
    });
    await waitFor(() => expect(renderedPins()).toHaveLength(1));

    // Navigate, and leave the new page's request in flight. The old pins must
    // already be gone — waiting for the fetch would mean drawing them over a
    // document they do not describe.
    await act(async () => {
      window.history.pushState({}, "", "/other");
      await Promise.resolve();
    });

    expect(renderedPins()).toHaveLength(0);
    await waitFor(() => expect(adapter.pending).toHaveLength(2));
    expect(adapter.pending[1]?.urlKey).toBe("/other");
  });

  it("renders the new page's pins once its own fetch resolves", async () => {
    const adapter = makeDeferredAdapter();
    renderOverlay({ adapter });

    await waitFor(() => expect(adapter.pending).toHaveLength(1));
    await act(async () => {
      adapter.pending[0]?.resolve([makeThread({ urlKey: "/", title: "Home thread" })]);
      await Promise.resolve();
    });
    await waitFor(() => expect(renderedPins()).toHaveLength(1));

    await act(async () => {
      window.history.pushState({}, "", "/other");
      await Promise.resolve();
    });
    await waitFor(() => expect(adapter.pending).toHaveLength(2));

    await act(async () => {
      adapter.pending[1]?.resolve([
        makeThread({ urlKey: "/other", title: "A" }),
        makeThread({ urlKey: "/other", title: "B" }),
      ]);
      await Promise.resolve();
    });

    await waitFor(() => expect(renderedPins()).toHaveLength(2));
  });

  it("does not let a request for the page being left overwrite the page being entered", async () => {
    const adapter = makeDeferredAdapter();
    const panel: { current: PanelRenderProps | null } = { current: null };
    renderOverlay({ adapter }, { renderPanel: (props) => ((panel.current = props), null) });

    // Navigate before the first page's request has come back at all.
    await waitFor(() => expect(adapter.pending).toHaveLength(1));
    await act(async () => {
      window.history.pushState({}, "", "/other");
      await Promise.resolve();
    });
    await waitFor(() => expect(adapter.pending).toHaveLength(2));

    // The page we are ON resolves first...
    await act(async () => {
      adapter.pending[1]?.resolve([makeThread({ urlKey: "/other", title: "Current page" })]);
      await Promise.resolve();
    });
    await waitFor(() => expect(renderedPins()).toHaveLength(1));

    // ...and only then does the abandoned page's request finally come back,
    // carrying three threads that must not appear anywhere.
    await act(async () => {
      adapter.pending[0]?.resolve([
        makeThread({ urlKey: "/", title: "Stale 1" }),
        makeThread({ urlKey: "/", title: "Stale 2" }),
        makeThread({ urlKey: "/", title: "Stale 3" }),
      ]);
      await Promise.resolve();
    });

    expect(renderedPins()).toHaveLength(1);
    act(() => panel.current?.onClose());
    // The seam agrees with the DOM: one thread, and it is the current page's.
    const open = await screen.findByRole("button", { name: /open the review panel/i });
    expect(open).toHaveAccessibleName("Open the review panel. 1 open on this page");
  });

  // The initial load is not the only request that can be in flight when the
  // reviewer leaves a page — the poll is, for the whole time they are on it,
  // so it races far more often. It reaches the adapter down its own path
  // (`reload`, not `probe`), and a guard on one of them is not a guard on the
  // other; this is the same scenario as the test above, entered through the
  // path that actually happens most.
  it("does not let a POLL for the page being left overwrite the page being entered", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const adapter = makeDeferredAdapter();
    renderOverlay({ adapter });

    await waitFor(() => expect(adapter.pending).toHaveLength(1));
    await act(async () => {
      adapter.pending[0]?.resolve([makeThread({ urlKey: "/", title: "Home thread" })]);
      await Promise.resolve();
    });
    await waitFor(() => expect(renderedPins()).toHaveLength(1));

    // Fire the poll registered for `/`, and leave its request outstanding —
    // a reviewer reading the page while a tick happens to be in flight.
    const poll = setIntervalSpy.mock.calls.find(([, ms]) => ms === 30_000)?.[0] as
      | (() => void)
      | undefined;
    if (!poll) throw new Error("expected a 30s setInterval registration");
    await act(async () => {
      poll();
      await Promise.resolve();
    });
    await waitFor(() => expect(adapter.pending).toHaveLength(2));
    expect(adapter.pending[1]?.urlKey).toBe("/");

    await act(async () => {
      window.history.pushState({}, "", "/other");
      await Promise.resolve();
    });
    await waitFor(() => expect(adapter.pending).toHaveLength(3));

    // The page being entered answers first...
    await act(async () => {
      adapter.pending[2]?.resolve([makeThread({ urlKey: "/other", title: "Current page" })]);
      await Promise.resolve();
    });
    await waitFor(() => expect(renderedPins()).toHaveLength(1));

    // ...and only now does the poll fired on the page being left come back.
    await act(async () => {
      adapter.pending[1]?.resolve([
        makeThread({ urlKey: "/", title: "Stale poll 1" }),
        makeThread({ urlKey: "/", title: "Stale poll 2" }),
      ]);
      await Promise.resolve();
    });

    // Neither two nor zero: the late poll did not paint its own threads, and
    // did not take the current page's down on its way past either.
    expect(renderedPins()).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /Current page/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stale poll/ })).toBeNull();
  });

  // The half no amount of request sequencing can cover. This list arrives for
  // the page being viewed, in answer to its own query, stamped truthfully —
  // and carries a row belonging somewhere else. Only the per-thread `urlKey`
  // match in `./overlay-root.tsx`'s `threads` derivation keeps it off the
  // page, which is why that check is there alongside the stamp rather than
  // instead of it.
  it("drops a foreign row from an otherwise-correct list for this page", async () => {
    const adapter = makeAdapter([]);
    adapter.listThreads = vi.fn(() =>
      Promise.resolve([
        makeThread({ urlKey: "/", title: "Belongs here" }),
        makeThread({ urlKey: "/somewhere-else", title: "Belongs elsewhere" }),
      ]),
    );
    renderOverlay({ adapter });

    expect(await screen.findByRole("button", { name: /Belongs here/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Belongs elsewhere/ })).toBeNull();
    expect(renderedPins()).toHaveLength(1);
    // The launcher's count agrees, rather than counting a pin nobody can see.
    expect(
      screen.getByRole("button", { name: "Open the review panel. 1 open on this page" }),
    ).toBeInTheDocument();
  });

  it("refetches for the new page and scopes the launcher's open count to it", async () => {
    const home = makeThread({ urlKey: "/", title: "Home thread" });
    const adapter = makeAdapter([home]);
    renderOverlay({ adapter });

    expect(
      await screen.findByRole("button", { name: "Open the review panel. 1 open on this page" }),
    ).toBeInTheDocument();

    await act(async () => {
      window.history.pushState({}, "", "/elsewhere");
      await Promise.resolve();
    });

    // `/elsewhere` has no threads, so the count disappears entirely rather
    // than carrying the previous page's number across.
    expect(
      await screen.findByRole("button", { name: "Open the review panel" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(adapter.listThreads).toHaveBeenCalledWith(
        expect.objectContaining({ urlKey: "/elsewhere" }),
      ),
    );
  });
});

describe("polling", () => {
  /** Spying on `setInterval` is the only way to read a cadence without waiting it out. */
  function spyOnSetInterval() {
    return vi.spyOn(window, "setInterval");
  }

  /**
   * The interval the overlay registered at exactly `delay`, if any.
   *
   * Matched on the exact cadence under test rather than "whichever interval
   * looks like ours": RTL, jsdom, and anything else sharing the worker
   * register intervals too, and a looser match makes this find one of theirs
   * and fail only when the suite happens to run in the wrong order.
   */
  function pollRegistration(spy: ReturnType<typeof spyOnSetInterval>, delay: number) {
    return spy.mock.calls.find(([, ms]) => ms === delay);
  }

  it("polls on the default 30s cadence", async () => {
    const setIntervalSpy = spyOnSetInterval();
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);

    const call = pollRegistration(setIntervalSpy, 30_000);
    const callback = call?.[0] as (() => void) | undefined;
    if (!callback) throw new Error("expected a 30s setInterval registration");

    await act(async () => {
      callback();
      await Promise.resolve();
    });

    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));
  });

  it("honours a configured pollMs instead of the default", async () => {
    const setIntervalSpy = spyOnSetInterval();
    const adapter = makeAdapter([]);
    renderOverlay({ adapter, pollMs: 5_000 });

    await screen.findByRole("button", { name: /review panel/i });
    expect(pollRegistration(setIntervalSpy, 5_000)).toBeDefined();
    // ...and specifically not on the cadence it would have used by default.
    expect(pollRegistration(setIntervalSpy, 30_000)).toBeUndefined();
  });

  it("registers no interval at all when pollMs is zero", async () => {
    const setIntervalSpy = spyOnSetInterval();
    const adapter = makeAdapter([]);
    renderOverlay({ adapter, pollMs: 0 });

    await screen.findByRole("button", { name: /review panel/i });
    // The initial probe still ran — "no interval" is not "no fetching".
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);
    // Neither the default cadence nor a degenerate zero-delay interval.
    expect(pollRegistration(setIntervalSpy, 30_000)).toBeUndefined();
    expect(pollRegistration(setIntervalSpy, 0)).toBeUndefined();
  });
});

describe("refetching on return to the page", () => {
  /**
   * A clock the throttle can be pushed past.
   *
   * Offset from the real `Date.now` rather than frozen: RTL's `waitFor`
   * measures its own timeout against `Date.now`, and a clock that never
   * advances would make every `waitFor` in this suite hang until the test
   * runner killed it.
   */
  let clockOffset = 0;
  const realNow = Date.now.bind(Date);

  beforeEach(() => {
    clockOffset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  });

  /** The last two cases navigate, and jsdom keeps the URL between tests. */
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  /** Past `REFETCH_THROTTLE_MS`, so the next return is allowed to refetch. */
  function letThrottleLapse() {
    clockOffset += 6_000;
  }

  async function returnToPage(event: "focus" | "visibilitychange") {
    await act(async () => {
      if (event === "focus") window.dispatchEvent(new Event("focus"));
      else document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
  }

  it("refetches when the page regains focus", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);

    letThrottleLapse();
    await returnToPage("focus");

    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));
  });

  it("refetches when the tab becomes visible again", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    letThrottleLapse();
    await returnToPage("visibilitychange");

    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));
  });

  it("still refetches on return when the interval is disabled", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter, pollMs: 0 });

    await screen.findByRole("button", { name: /review panel/i });
    letThrottleLapse();
    await returnToPage("focus");

    // This is the contract `ReviewConfig.pollMs` documents: `0` means "not on
    // a clock", never "never".
    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));
  });

  it("coalesces the focus and visibilitychange pair a single tab switch fires", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    letThrottleLapse();

    // One alt-tab back, both events — the reviewer returned once and must
    // cost one request, not two.
    await returnToPage("focus");
    await returnToPage("visibilitychange");

    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));
    expect(adapter.listThreads).toHaveBeenCalledTimes(2);
  });

  it("suppresses a return inside the throttle window and allows the next one after it", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    letThrottleLapse();
    await returnToPage("focus");
    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));

    // Still inside the window. The clock is an OFFSET on the real one, so
    // these steps are deliberately not pressed up against the exact
    // millisecond boundary — real time passing inside `act` would decide the
    // result instead of the offset. The exact cadence is stated once, in
    // `REFETCH_THROTTLE_MS`; what this brackets is that there is a window,
    // that it is seconds rather than milliseconds, and that it closes.
    clockOffset += 4_000;
    await returnToPage("focus");
    expect(adapter.listThreads).toHaveBeenCalledTimes(2);

    // Past it, and the next return costs a request again. Reaching here also
    // proves the suppressed attempt did not restart the window: the total
    // advance since the last real fetch is 6s, so a throttle that reset on
    // every event would still be holding this one back.
    clockOffset += 2_000;
    await returnToPage("focus");
    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(3));
  });

  /**
   * An adapter that parks every `listThreads` call, so a test can decide when
   * — and whether — a request comes back. The whole subject below is what the
   * throttle does with requests that are still out or never land, which a
   * resolving adapter cannot express.
   */
  function makeParkedAdapter() {
    const pending: Array<{ urlKey: string; resolve: (list: ReviewThreadView[]) => void }> = [];
    const adapter = makeAdapter([]);
    adapter.listThreads = vi.fn(
      (params: ListThreadsParams) =>
        new Promise<ReviewThreadView[]>((resolve) => {
          pending.push({ urlKey: params.urlKey ?? "", resolve });
        }),
    );
    return { adapter, pending };
  }

  /** Lands a parked request and lets React settle. */
  async function land(
    entry: { resolve: (list: ReviewThreadView[]) => void } | undefined,
    list: ReviewThreadView[] = [],
  ) {
    await act(async () => {
      entry?.resolve(list);
      await Promise.resolve();
    });
  }

  // The throttle is measured from fetches that LAND, so on its own it cannot
  // separate the two events one alt-tab fires: they arrive in the same task,
  // before anything either of them starts could have come back to stamp it.
  // What keeps this to one request is the in-flight guard, and parking the
  // request is the only way to hold the window open long enough to prove that
  // rather than to prove a microtask happened to win a race.
  it("costs one request when a return's two events both fire before the first has landed", async () => {
    const { adapter, pending } = makeParkedAdapter();
    renderOverlay({ adapter });

    await waitFor(() => expect(pending).toHaveLength(1));
    await land(pending[0]);
    await screen.findByRole("button", { name: /review panel/i });

    letThrottleLapse();
    await returnToPage("focus");
    await returnToPage("visibilitychange");

    expect(adapter.listThreads).toHaveBeenCalledTimes(2);
    expect(pending).toHaveLength(2);
  });

  // "Time since the last fetch" means the last one that LANDED. A request
  // that errored left the reviewer looking at exactly the list they had
  // before they walked away, so holding the next return off on its account
  // would be holding it off on the strength of a failure.
  it("does not count a fetch that failed — the next return may try again", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);

    adapter.listThreads.mockRejectedValue(new Error("network down"));
    letThrottleLapse();
    await returnToPage("focus");
    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(2));

    await returnToPage("focus");
    await waitFor(() => expect(adapter.listThreads).toHaveBeenCalledTimes(3));
  });

  // Same rule, from the other direction: a response that arrived but was
  // DROPPED for belonging to the page the reviewer has left did not fetch
  // anything for the page they are on, and must not hold off the fetch that
  // will. (`page scoping` below owns the dropping itself; what is asserted
  // here is only that it does not count as a fetch.)
  it("does not count a response the commit dropped for belonging to the page we left", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const { adapter, pending } = makeParkedAdapter();
    renderOverlay({ adapter });

    // The mount probe lands for "/" — a real fetch, which stamps.
    await waitFor(() => expect(pending).toHaveLength(1));
    await land(pending[0]);
    await screen.findByRole("button", { name: /review panel/i });

    // A poll goes out for "/" and stays out.
    const poll = setIntervalSpy.mock.calls.find(([, ms]) => ms === 30_000)?.[0] as
      | (() => void)
      | undefined;
    if (!poll) throw new Error("expected a 30s setInterval registration");
    await act(async () => {
      poll();
      await Promise.resolve();
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]?.urlKey).toBe("/");

    // The reviewer navigates. The new page's own probe goes out.
    await act(async () => {
      window.history.pushState({}, "", "/other");
      await Promise.resolve();
    });
    await waitFor(() => expect(pending).toHaveLength(3));

    // The window is open, and now the poll fired on the page they left comes
    // back — straight into the commit's guard, which drops it.
    letThrottleLapse();
    await land(pending[1], [makeThread({ urlKey: "/", title: "Stale" })]);

    // So the window is still open, and returning still costs a request. A
    // stamp on the dropped write would have closed it, leaving the page they
    // are actually on waiting out a full throttle for data it never got.
    await returnToPage("focus");
    await waitFor(() => expect(pending).toHaveLength(4));
    expect(pending[3]?.urlKey).toBe("/other");
  });

  it("does not refetch on either event while the gate is locked", async () => {
    const adapter = makeAdapter([]);
    adapter.listThreads = vi.fn(() => Promise.reject(new ReviewApiError(401, "locked")));
    renderOverlay({ adapter });

    // The locked launcher is the gate reporting itself.
    await screen.findByRole("button", { name: /review is locked/i });
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);

    letThrottleLapse();
    setVisibility("visible");
    await returnToPage("focus");
    await returnToPage("visibilitychange");

    // A refetch here is a request the reviewer has no permission to make,
    // repeated every time they so much as glance at the tab.
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when the overlay has no urlKey for this page", async () => {
    const adapter = makeAdapter([]);
    // A consumer's `urlKeyFromHref` declining to key this page at all — its
    // documented way of saying "threads are not grouped for this URL". There
    // is nothing to fetch, so there is nothing to refetch either, and coming
    // back to the tab must not invent a request with an empty key in it.
    renderOverlay({ adapter, urlKeyFromHref: () => "" });

    await screen.findByRole("button", { name: /checking review access/i });
    expect(adapter.listThreads).not.toHaveBeenCalled();

    letThrottleLapse();
    setVisibility("visible");
    await returnToPage("focus");
    await returnToPage("visibilitychange");

    expect(adapter.listThreads).not.toHaveBeenCalled();
  });

  it("does not refetch while the page is going hidden", async () => {
    const adapter = makeAdapter([]);
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    letThrottleLapse();

    setVisibility("hidden");
    await returnToPage("visibilitychange");

    // Leaving is not returning; nothing is waiting to be seen.
    expect(adapter.listThreads).toHaveBeenCalledTimes(1);
  });
});

describe("accessibility", () => {
  it("announces via the live region and tags every owned node with OVERLAY_ATTR", async () => {
    const target = document.createElement("div");
    target.setAttribute("data-testid", "thing");
    target.textContent = "Thing";
    document.body.appendChild(target);
    stubRect(target, { x: 0, y: 0, w: 100, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    const adapter = makeAdapter([]);
    const user = userEvent.setup();
    renderOverlay({ adapter });

    await screen.findByRole("button", { name: /review panel/i });
    const liveRegion = document.querySelector('[role="status"]');
    expect(liveRegion).toBeTruthy();

    await user.keyboard("c");
    await waitFor(() => expect(liveRegion?.textContent).toMatch(/pin-drop mode on/i));

    await user.click(target);
    await waitFor(() => expect(liveRegion?.textContent).toMatch(/pin dropped/i));

    const owned = document.body.querySelectorAll(`[${OVERLAY_ATTR}]`);
    expect(owned.length).toBeGreaterThan(0);
    owned.forEach((el) => expect(el.getAttribute(OVERLAY_ATTR)).toBe(""));
  });
});

// WP25 / defect 1: `beginScreenshot`'s resulting `shotState` must never
// claim "done" (attached) unless `adapter.uploadScreenshot` actually
// returned a key — see the sibling suite in `./composer.test.tsx` for the
// UI-copy side of this same contract.
describe("screenshot lifecycle", () => {
  // `vi.restoreAllMocks()` in the top-level `afterEach` only restores spies
  // created via `vi.spyOn` — it does not reset the call history or resolved
  // value of `captureScreenshot`, a plain `vi.fn()` supplied by the
  // top-of-file `vi.mock` factory. Without this, a later test in this suite
  // would see call counts left over from an earlier one.
  beforeEach(() => {
    vi.mocked(captureScreenshot).mockReset();
  });

  function dropPinAndCapture(
    target: HTMLElement,
    extraAdapter: Partial<{ uploadScreenshot: (blob: Blob) => Promise<string | null> }>,
  ) {
    stubRect(target, { x: 0, y: 0, w: 100, h: 40 });
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
    const adapter = { ...makeAdapter([]), ...extraAdapter };
    const shotStates: Array<string> = [];
    const user = userEvent.setup();
    renderOverlay(
      { adapter },
      {
        renderComposer: (props) => {
          shotStates.push(props.shotState);
          return null;
        },
      },
    );
    return { adapter, shotStates, user };
  }

  it('never reports "done" when uploadScreenshot resolves null — it reports "unavailable" instead', async () => {
    vi.mocked(captureScreenshot).mockResolvedValue(new Blob(["x"], { type: "image/png" }));
    const target = document.createElement("div");
    document.body.appendChild(target);
    const { shotStates, user } = dropPinAndCapture(target, {
      uploadScreenshot: vi.fn().mockResolvedValue(null),
    });

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);

    await waitFor(() => expect(shotStates).toContain("unavailable"));
    expect(shotStates).not.toContain("done");
  });

  it('reports "done" when uploadScreenshot resolves a real key', async () => {
    vi.mocked(captureScreenshot).mockResolvedValue(new Blob(["x"], { type: "image/png" }));
    const target = document.createElement("div");
    document.body.appendChild(target);
    const { shotStates, user } = dropPinAndCapture(target, {
      uploadScreenshot: vi.fn().mockResolvedValue("shots/abc123.png"),
    });

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);

    await waitFor(() => expect(shotStates).toContain("done"));
    expect(shotStates).not.toContain("unavailable");
  });

  it("never attempts a capture, and shotState stays idle, when the adapter has no uploadScreenshot at all", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const { shotStates, user } = dropPinAndCapture(target, {});

    await screen.findByRole("button", { name: /review panel/i });
    await user.keyboard("c");
    await user.click(target);

    await waitFor(() => expect(shotStates.length).toBeGreaterThan(0));
    expect(captureScreenshot).not.toHaveBeenCalled();
    expect(shotStates.every((s) => s === "idle")).toBe(true);
  });
});
