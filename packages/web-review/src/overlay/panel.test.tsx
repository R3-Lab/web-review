/**
 * `Panel` interaction tests (vitest + jsdom + React Testing Library).
 *
 * Renders `Panel` directly against a minimal `PanelRenderProps` fixture — no
 * `OverlayRoot` involved — so these tests exercise exactly the seam `Panel`
 * implements against (`./overlay-root`'s `PanelRenderProps`) in isolation.
 * `ThreadDetail` (rendered internally by `Panel` once `selected` is set) has
 * its own dedicated test file, `./thread-detail.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import type { ReviewAdapter } from "../core/adapter";
import { resolveConfig } from "../core/config";
import type { Anchor, ReviewThreadView } from "../core/types";
import { Panel } from "./panel";
import type { PanelRenderProps } from "./overlay-root";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

function makeAdapter(): ReviewAdapter {
  return {
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    addComment: vi.fn(),
    setStatus: vi.fn(),
  };
}

function renderPanel(propsOverride: Partial<PanelRenderProps> = {}) {
  const config = resolveConfig({ adapter: makeAdapter() });
  const onFilterChange = vi.fn();
  const onSelect = vi.fn();
  const onToggleHighlights = vi.fn();
  const onToggleShowPins = vi.fn();
  const onTogglePinDrop = vi.fn();
  const onClose = vi.fn();
  const onBack = vi.fn();
  const onReply = vi.fn(() => Promise.resolve());
  const onToggleStatus = vi.fn(() => Promise.resolve());
  const onUnlocked = vi.fn();
  const props: PanelRenderProps = {
    config,
    urlKey: "/",
    threads: [],
    filter: "open",
    onFilterChange,
    selected: null,
    selectedResolved: undefined,
    identity: { id: "u1", name: "Ada" },
    // "right" is what `panelSideForEdge` returns for the launcher's default
    // edge, so the fixture describes the default configuration.
    panelSide: "right",
    showHighlights: true,
    onToggleHighlights,
    showPins: true,
    onToggleShowPins,
    // The ordinary case: every pin on this page found its anchor, so the
    // summary is absent. Cases that expect it say so explicitly.
    unplaceableCount: 0,
    pinDropMode: false,
    onTogglePinDrop,
    onClose,
    onSelect,
    onBack,
    onReply,
    onToggleStatus,
    onUnlocked,
    ...propsOverride,
  };
  const utils = render(<Panel {...props} />);
  return {
    ...utils,
    onFilterChange,
    onSelect,
    onToggleHighlights,
    onToggleShowPins,
    onTogglePinDrop,
    onClose,
    onBack,
    onReply,
    onToggleStatus,
    onUnlocked,
    props,
  };
}

describe("Panel", () => {
  it("renders one row per thread, showing category, title, author, comment count, and status", () => {
    const open = makeThread({
      title: "First issue",
      category: "bug",
      authorName: "Grace",
      commentCount: 3,
      status: "open",
      comments: [
        {
          id: "c1",
          threadId: "irrelevant",
          body: "The first comment's body",
          authorId: "u1",
          authorName: "Grace",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const resolved = makeThread({ title: "Second issue", status: "resolved" });
    renderPanel({ threads: [open, resolved] });

    const row = screen.getByRole("button", { name: /first issue/i });
    expect(row).toHaveTextContent("Bug");
    expect(row).toHaveTextContent("Open");
    expect(row).toHaveTextContent("3 comments");
    expect(row).toHaveTextContent("Grace");
    expect(row).toHaveTextContent("The first comment's body");

    expect(screen.getByRole("button", { name: /second issue/i })).toHaveTextContent("Resolved");
  });

  it("calls onFilterChange when a filter chip is clicked", async () => {
    const user = userEvent.setup();
    const { onFilterChange } = renderPanel();
    await user.click(screen.getByRole("button", { name: /^resolved$/i }));
    expect(onFilterChange).toHaveBeenCalledWith("resolved");
  });

  it("calls onSelect with the thread id when a row is clicked", async () => {
    const user = userEvent.setup();
    const thread = makeThread({ title: "Click me" });
    const { onSelect } = renderPanel({ threads: [thread] });
    await user.click(screen.getByRole("button", { name: /click me/i }));
    expect(onSelect).toHaveBeenCalledWith(thread.id);
  });

  it("calls onToggleHighlights when the highlight checkbox is toggled", async () => {
    const user = userEvent.setup();
    const { onToggleHighlights } = renderPanel();
    await user.click(screen.getByRole("checkbox", { name: /highlights/i }));
    expect(onToggleHighlights).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleShowPins when the pins checkbox is toggled, and nothing else", async () => {
    const user = userEvent.setup();
    const { onToggleShowPins, onToggleHighlights } = renderPanel();
    await user.click(screen.getByRole("checkbox", { name: /^pins$/i }));
    expect(onToggleShowPins).toHaveBeenCalledTimes(1);
    // The two layers are independent axes, and the wiring is the first place
    // that can quietly stop being true.
    expect(onToggleHighlights).not.toHaveBeenCalled();
  });

  it("reflects each visibility prop on its own checkbox, in every combination", () => {
    const cases: [boolean, boolean][] = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ];
    for (const [showPins, showHighlights] of cases) {
      renderPanel({ showPins, showHighlights });
      const pins = screen.getByRole("checkbox", { name: /^pins$/i });
      const highlights = screen.getByRole("checkbox", { name: /highlights/i });
      if (showPins) expect(pins).toBeChecked();
      else expect(pins).not.toBeChecked();
      if (showHighlights) expect(highlights).toBeChecked();
      else expect(highlights).not.toBeChecked();
      cleanup();
    }
  });

  it("groups the two visibility switches under a name of their own", () => {
    renderPanel();
    const group = screen.getByRole("group", { name: /show on the page/i });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(2);
  });

  it("calls onClose when the close button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();
    await user.click(screen.getByRole("button", { name: /close the review panel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel();
    // The panel deliberately never steals focus on open (`useFocusTrap`'s
    // `autoFocus: false` — see the comment on `Panel`'s own `ref`), so a
    // keyboard user reaching for Escape must already have focus somewhere
    // inside it; clicking a real control here is the realistic way to get
    // there rather than asserting Escape works with focus still on <body>.
    await user.click(screen.getByRole("checkbox", { name: /highlights/i }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders ThreadDetail instead of the list once a thread is selected", () => {
    const thread = makeThread({ title: "Selected thread" });
    renderPanel({ threads: [thread], selected: thread });
    expect(screen.getByRole("heading", { name: /^thread$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /all feedback/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^resolved$/i })).not.toBeInTheDocument();
  });

  it("docks to the side it is told to, for both sides", () => {
    renderPanel({ panelSide: "right" });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "right");
    cleanup();

    renderPanel({ panelSide: "left" });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "left");
  });
});

// The launcher opens the panel and nothing else (WP2), so the explicit
// "arm picking" action lives here — and it is the ONLY primary action on this
// surface.
describe("Panel — the New comment control", () => {
  it("renders in the list view and calls onTogglePinDrop exactly once per click", async () => {
    const user = userEvent.setup();
    const { onTogglePinDrop } = renderPanel();
    await user.click(screen.getByRole("button", { name: /new comment/i }));
    expect(onTogglePinDrop).toHaveBeenCalledTimes(1);
  });

  it("carries aria-pressed matching pinDropMode", () => {
    renderPanel({ pinDropMode: false });
    expect(screen.getByRole("button", { name: /new comment/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    cleanup();

    renderPanel({ pinDropMode: true });
    expect(screen.getByRole("button", { name: /cancel adding a comment/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers the shortcut hint when idle and the cancel affordance (without it) when armed", () => {
    const { unmount } = renderPanel({ pinDropMode: false });
    const idle = screen.getByRole("button", { name: /new comment/i });
    expect(idle).toHaveTextContent("New comment");
    // The `c` shortcut is advertised here precisely because the launcher's
    // own label stopped advertising it.
    expect(idle.querySelector("kbd")).toHaveTextContent("C");
    unmount();

    renderPanel({ pinDropMode: true });
    const armed = screen.getByRole("button", { name: /cancel adding a comment/i });
    expect(armed).toHaveTextContent("Cancel");
    expect(armed).not.toHaveTextContent("New comment");
    // No hint while armed: the on-page capture hint already says what to
    // click and that Escape cancels.
    expect(armed.querySelector("kbd")).toBeNull();
  });

  it("is absent in the detail view, where the back button is the primary action", () => {
    const thread = makeThread({ title: "Selected thread" });
    renderPanel({ threads: [thread], selected: thread });
    expect(screen.queryByRole("button", { name: /new comment/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel adding a comment/i })).not.toBeInTheDocument();
  });
});

// The strip documents the OVERLAY, not the list, so it is present on both
// views — and every entry names a binding that really exists (`c`, Escape and
// the held `h` in `OverlayRoot`'s keydown handlers, the arrow keys in
// `Launcher`'s).
describe("Panel — the keyboard shortcuts footer", () => {
  function expectShortcuts() {
    const list = screen.getByRole("list", { name: /keyboard shortcuts/i });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]!).toHaveTextContent(/^C\s*New pin$/);
    expect(items[1]!).toHaveTextContent(/^Esc\s*Close \/ cancel$/);
    // A key that must be HELD, and the label has to say so — a reviewer who
    // taps it and sees nothing happen would reasonably conclude it is broken.
    expect(items[2]!).toHaveTextContent(/^H\s*Hold to click through the pins$/);
    // The arrows are the WCAG 2.5.7 alternative to dragging the launcher and
    // only work while it has focus — the label must not imply they are global.
    expect(items[3]!).toHaveTextContent(/while it has focus/i);
    expect(within(items[3]!).getAllByText(/^[←↑↓→]$/)).toHaveLength(4);
  }

  it("renders in the list view, named, with all four shortcuts", () => {
    renderPanel();
    expectShortcuts();
  });

  // The list is called "Keyboard shortcuts" and every row in it is a key, so
  // the pointer-operated escape is named beside the list rather than inside
  // it. Both views: it is as true in the detail view as in the list.
  it("names the persistent Pins switch alongside the held key, outside the list", () => {
    for (const selected of [null, makeThread({ title: "Selected thread" })]) {
      renderPanel(selected ? { threads: [selected], selected } : {});
      const footer = screen.getByRole("list", { name: /keyboard shortcuts/i }).closest("footer");
      if (!footer) throw new Error("expected the shortcuts list's <footer> ancestor");
      expect(footer).toHaveTextContent(/hide the pins for good/i);
      // Beside the list, not a fifth row of it.
      expect(within(footer).getAllByRole("listitem")).toHaveLength(4);
      cleanup();
    }
  });

  it("renders in the detail view too", () => {
    const thread = makeThread({ title: "Selected thread" });
    renderPanel({ threads: [thread], selected: thread });
    expectShortcuts();
  });

  it("sits outside the scrolling panel body, so a long list cannot scroll it away", () => {
    renderPanel({ threads: [makeThread(), makeThread(), makeThread()] });
    const footer = screen.getByRole("list", { name: /keyboard shortcuts/i }).closest("footer");
    if (!footer) throw new Error("expected the shortcuts list's <footer> ancestor");
    expect(footer.closest(".r3wr-panel-body")).toBeNull();
    expect(footer.parentElement).toHaveClass("r3wr-panel");
    // Last child, i.e. after `.r3wr-panel-body` — the strip is pinned below it.
    expect(footer.previousElementSibling).toHaveClass("r3wr-panel-body");
  });
});

/**
 * One line for the page in place of N identical badges. These are copy tests
 * as much as render tests, for the same reason `./pin.test.tsx`'s are: what
 * this line is allowed to CLAIM is the whole of the feature. An anchor that
 * resolved to nothing licenses "we did not find it here" and nothing further
 * — not that the page changed, not that anything was deleted.
 */
describe("Panel — the unplaceable-pins summary", () => {
  /** The summary line, whatever its wording, or `null`. */
  function summary(): HTMLElement | null {
    return screen.queryByText(/couldn't be placed/i);
  }

  it("is absent entirely when every pin found its anchor", () => {
    renderPanel({ threads: [makeThread()], unplaceableCount: 0 });
    expect(summary()).toBeNull();
  });

  it("is singular for one", () => {
    renderPanel({ threads: [makeThread()], unplaceableCount: 1 });
    expect(summary()).toHaveTextContent(
      "1 pin couldn't be placed on this page. It is shown where it was dropped.",
    );
  });

  it("is plural for more than one, and carries the count", () => {
    renderPanel({ threads: [makeThread(), makeThread(), makeThread()], unplaceableCount: 3 });
    expect(summary()).toHaveTextContent(
      "3 pins couldn't be placed on this page. They are shown where they were dropped.",
    );
  });

  it("does not claim a cause — nothing about drift, change, or a missing element", () => {
    renderPanel({ threads: [makeThread(), makeThread()], unplaceableCount: 2 });
    const copy = summary()?.textContent ?? "";
    expect(copy).not.toMatch(/drift/i);
    expect(copy).not.toMatch(/chang/i);
    expect(copy).not.toMatch(/removed|deleted|gone|missing|no longer/i);
  });

  it("does not replace the pins' own rows — the threads are still listed", () => {
    const thread = makeThread({ title: "Still listed" });
    renderPanel({ threads: [thread], unplaceableCount: 1 });
    expect(summary()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /still listed/i })).toBeInTheDocument();
  });

  it("stays out of the detail view, which speaks for one thread at a time", () => {
    const thread = makeThread({ title: "Selected thread" });
    renderPanel({ threads: [thread], selected: thread, unplaceableCount: 2 });
    expect(summary()).toBeNull();
  });
});
