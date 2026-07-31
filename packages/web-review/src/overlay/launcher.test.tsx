/**
 * `Launcher` interaction tests (vitest + jsdom + React Testing Library).
 *
 * Renders `Launcher` directly against its own `LauncherProps` — it imports
 * nothing from `./overlay-root`, so there is nothing to stand up around it.
 *
 * jsdom has no layout engine and no pointer capture, which shapes this file:
 *  - `getBoundingClientRect` returns zeros, so the button's rect is stubbed
 *    explicitly (the pattern comes from `../anchor.test.ts`) and
 *    `innerWidth`/`innerHeight` are defined outright. Nothing here relies on
 *    a real measurement.
 *  - Drags are driven with `fireEvent` rather than `userEvent.pointer`,
 *    because these assertions are entirely about specific `clientX`/`clientY`
 *    values — where the pointer travelled is the behaviour under test, and
 *    `fireEvent` is the only way to state it exactly. Clicks and keystrokes
 *    still go through `userEvent`, as everywhere else in this suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

import { OVERLAY_ATTR } from "../anchor";
import { Launcher } from "./launcher";
import type { LauncherProps } from "./launcher";
import { DEFAULT_LAUNCHER_POSITION } from "./launcher-position";

const TAG = { [OVERLAY_ATTR]: "" };

/** The stubbed viewport every test measures against. */
const VIEWPORT = { width: 1000, height: 800 };

/** The stubbed size of the launcher pill itself. */
const PILL = { width: 132, height: 44 };

/**
 * Where the stubbed `getBoundingClientRect` claims the button is. Mutated by
 * `placePill` so a drag test can start from a known on-screen box.
 */
let pillRect = { left: 850, top: 738 };

function placePill(left: number, top: number) {
  pillRect = { left, top };
}

beforeEach(() => {
  placePill(850, 738);
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: VIEWPORT.width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: VIEWPORT.height,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: pillRect.left,
    y: pillRect.top,
    left: pillRect.left,
    top: pillRect.top,
    width: PILL.width,
    height: PILL.height,
    right: pillRect.left + PILL.width,
    bottom: pillRect.top + PILL.height,
    toJSON() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderLauncher(overrides: Partial<LauncherProps> = {}) {
  const onPositionChange = vi.fn();
  const onActivate = vi.fn();
  const props: LauncherProps = {
    position: DEFAULT_LAUNCHER_POSITION,
    onPositionChange,
    tag: TAG,
    variant: "unlocked",
    expanded: false,
    onActivate,
    label: "Drop a review pin",
    ...overrides,
  };
  const utils = render(<Launcher {...props} />);
  const button = screen.getByRole("button", { name: props.label });
  return { ...utils, button, onPositionChange, onActivate, props };
}

/**
 * One pointer gesture: press at `from`, move through every `via` point, and
 * release at the last one. Coordinates are viewport px, exactly as a real
 * `PointerEvent` would carry them.
 */
function drag(button: HTMLElement, from: { x: number; y: number }, ...via: { x: number; y: number }[]) {
  const pointerId = 1;
  fireEvent.pointerDown(button, { pointerId, button: 0, clientX: from.x, clientY: from.y });
  let last = from;
  for (const point of via) {
    fireEvent.pointerMove(window, { pointerId, clientX: point.x, clientY: point.y });
    last = point;
  }
  fireEvent.pointerUp(window, { pointerId, clientX: last.x, clientY: last.y });
  // The browser fires a `click` after a pointer release on the pressed
  // element; the component's job is to swallow it after a real drag, so the
  // test has to actually deliver one.
  fireEvent.click(button);
}

describe("Launcher rendering", () => {
  it("renders the checking variant disabled and marked locked, with the key glyph but no dialog hint", () => {
    const { button } = renderLauncher({ variant: "checking", label: "Checking review access" });
    expect(button).toBeDisabled();
    // `data-locked` means "this is the gate's button", which `checking` is —
    // there is just no dialog behind it yet, hence no `aria-haspopup`.
    expect(button).toHaveAttribute("data-locked", "true");
    expect(button).not.toHaveAttribute("aria-haspopup");
    expect(button.querySelector("svg")).toBeInTheDocument();
    expect(button).toHaveTextContent("Review");
  });

  it("renders the locked variant with data-locked and a dialog popup hint", () => {
    const { button } = renderLauncher({ variant: "locked", label: "Review is locked" });
    expect(button).toHaveAttribute("data-locked", "true");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).not.toBeDisabled();
  });

  it("renders the unlocked variant enabled, with no data-locked and no popup hint", () => {
    const { button } = renderLauncher({ variant: "unlocked" });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute("data-locked");
    expect(button).not.toHaveAttribute("aria-haspopup");
  });

  it("draws a different glyph for the unlocked variant than for the gate variants", () => {
    const { button } = renderLauncher({ variant: "unlocked" });
    const unlockedGlyph = button.querySelector("svg")?.innerHTML;
    cleanup();
    const locked = renderLauncher({ variant: "locked" });
    expect(locked.button.querySelector("svg")?.innerHTML).not.toBe(unlockedGlyph);
  });

  it("reflects the docked edge and the expanded state on the button", () => {
    const { button } = renderLauncher({
      position: { edge: "top", offset: 0.5 },
      expanded: true,
    });
    expect(button).toHaveAttribute("data-edge", "top");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).not.toHaveAttribute("data-dragging");
  });

  it("tags every node it renders so the overlay can recognise its own DOM", () => {
    const { button } = renderLauncher({ count: 3 });
    expect(button).toHaveAttribute(OVERLAY_ATTR);
    // Only the nodes this component itself renders — the glyph paths inside
    // an icon belong to `./icons`, and `isOverlayNode` (`../anchor`) matches
    // with `closest()`, so a tagged ancestor already covers them.
    for (const node of button.children) {
      expect(node).toHaveAttribute(OVERLAY_ATTR);
    }
    expect(button.children.length).toBe(3);
  });

  it("positions itself along its edge with the --r3wr-launcher-pos custom property", () => {
    // Right edge, offset 1: the vertical track is 800 - 44 = 756, and the far
    // end of it is one 18px margin in, at 738.
    const { button } = renderLauncher({ position: { edge: "right", offset: 1 } });
    expect(button.style.getPropertyValue("--r3wr-launcher-pos")).toBe("738px");
  });
});

// WP9: the launcher and the panel it opens both dock to a viewport edge, and
// in the shipped default they docked to the same one — the pill landed on the
// panel's keyboard-shortcuts strip. `dock` is how the host says "the panel is
// up, on this side"; what the component does with it is resolve
// `--r3wr-launcher-pos` against a shorter track.
describe("Launcher panel-dock clearance", () => {
  it("clamps a bottom-docked launcher clear of a right-docked panel's column", () => {
    // Shut: the far end of the 1000 - 132 = 868px track, one 18px margin in.
    const shut = renderLauncher({ position: { edge: "bottom", offset: 1 } });
    expect(shut.button.style.getPropertyValue("--r3wr-launcher-pos")).toBe("850px");
    cleanup();

    // Open: the panel's 384px column is taken off the far end instead —
    // 1000 - 384 - 132 - 18 = 466, which puts the pill's right edge at 598,
    // one margin clear of a panel that starts at 616.
    const open = renderLauncher({
      position: { edge: "bottom", offset: 1 },
      dock: { side: "right" },
    });
    expect(open.button.style.getPropertyValue("--r3wr-launcher-pos")).toBe("466px");
  });

  it("leaves the same-edge case alone — that step is a stylesheet inset, not this property", () => {
    // A right-docked launcher with a right-docked panel is the collision the
    // `overlay.css` rules handle, on the perpendicular axis. This property
    // carries the ALONG-edge position, which must read identically either way;
    // a change here would move the pill up or down the edge for no reason.
    const shut = renderLauncher({ position: { edge: "right", offset: 1 } });
    const withoutDock = shut.button.style.getPropertyValue("--r3wr-launcher-pos");
    expect(withoutDock).toBe("738px");
    cleanup();

    const open = renderLauncher({
      position: { edge: "right", offset: 1 },
      dock: { side: "right" },
    });
    expect(open.button.style.getPropertyValue("--r3wr-launcher-pos")).toBe(withoutDock);
    // And the attributes the stylesheet's half keys on are the ones it needs:
    // the edge, and no drag in progress.
    expect(open.button).toHaveAttribute("data-edge", "right");
    expect(open.button).not.toHaveAttribute("data-dragging");
  });

  it("keeps following the pointer while a drag is in flight, dock or no dock", () => {
    // The docked clamp resolves `--r3wr-launcher-pos`; a drag writes inline
    // `left`/`top` that beat it outright. Nothing about an open panel may
    // interfere with carrying the pill.
    const { button } = renderLauncher({
      position: { edge: "bottom", offset: 1 },
      dock: { side: "right" },
    });
    fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 860, clientY: 748 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 900, clientY: 300 });

    expect(button).toHaveAttribute("data-dragging", "true");
    expect(button.style.left).toBe("890px");
    expect(button.style.top).toBe("290px");
  });
});

describe("Launcher count badge", () => {
  it("shows the open-thread count for the unlocked variant", () => {
    const { button } = renderLauncher({ variant: "unlocked", count: 4 });
    expect(button.querySelector(".r3wr-toggle-count")).toHaveTextContent("4");
  });

  it("hides the badge when the count is zero or absent", () => {
    const zero = renderLauncher({ variant: "unlocked", count: 0 });
    expect(zero.button.querySelector(".r3wr-toggle-count")).toBeNull();
    cleanup();
    const absent = renderLauncher({ variant: "unlocked" });
    expect(absent.button.querySelector(".r3wr-toggle-count")).toBeNull();
  });

  it("hides the badge on the locked variant even with open threads", () => {
    const { button } = renderLauncher({ variant: "locked", count: 7 });
    expect(button.querySelector(".r3wr-toggle-count")).toBeNull();
  });
});

describe("Launcher activation", () => {
  it("calls onActivate once for an ordinary click", async () => {
    const user = userEvent.setup();
    const { button, onActivate, onPositionChange } = renderLauncher();
    await user.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it("treats a press that never crosses the drag threshold as a click", () => {
    const { button, onActivate, onPositionChange } = renderLauncher();
    // 3px of travel — under LAUNCHER_DRAG_THRESHOLD_PX, so this is a hand
    // tremor, not a drag.
    drag(button, { x: 900, y: 760 }, { x: 902, y: 762 });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onPositionChange).not.toHaveBeenCalled();
    expect(button).not.toHaveAttribute("data-dragging");
  });

  it("still activates from the keyboard", async () => {
    const user = userEvent.setup();
    const { button, onActivate } = renderLauncher();
    button.focus();
    await user.keyboard("{Enter}");
    expect(onActivate).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("ignores a secondary mouse button entirely", () => {
    const { button, onActivate, onPositionChange } = renderLauncher();
    fireEvent.pointerDown(button, { pointerId: 1, button: 2, clientX: 900, clientY: 760 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 400 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 400 });
    expect(onPositionChange).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    expect(button).not.toHaveAttribute("data-dragging");
  });
});

describe("Launcher dragging", () => {
  it("marks itself as dragging and follows the pointer once past the threshold", () => {
    const { button } = renderLauncher();
    // Grabbed 10px in from the pill's left edge and 10px down from its top.
    fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 860, clientY: 748 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 300 });

    expect(button).toHaveAttribute("data-dragging", "true");
    // The grab offset is preserved: the pill's top-left tracks the pointer
    // minus where inside it the grab landed.
    expect(button.style.left).toBe("390px");
    expect(button.style.top).toBe("290px");
  });

  it("snaps to the nearest edge on release and does not activate", () => {
    const { button, onPositionChange, onActivate } = renderLauncher();
    // Grab the pill by its top-left corner, drag it to the left edge.
    drag(button, { x: 850, y: 738 }, { x: 600, y: 500 }, { x: 30, y: 400 });

    expect(onActivate).not.toHaveBeenCalled();
    expect(onPositionChange).toHaveBeenCalledTimes(1);
    // Released with the pill's top-left at (30, 400), so its centre is at
    // (96, 422): 96 from the left, 904 from the right, 400 from the top,
    // 378 from the bottom. Left wins; the offset is 422 / 800.
    expect(onPositionChange).toHaveBeenCalledWith({ edge: "left", offset: 422 / 800 });
    expect(button).not.toHaveAttribute("data-dragging");
  });

  it("snaps to each of the other three edges from the same starting pill", () => {
    const toTop = renderLauncher();
    // Centre lands at (566, 32) → top is nearest, and the offset is measured
    // from the CENTRE, not from where the pointer happened to be.
    drag(toTop.button, { x: 850, y: 738 }, { x: 500, y: 10 });
    expect(toTop.onPositionChange).toHaveBeenCalledWith({ edge: "top", offset: 566 / 1000 });
    cleanup();

    const toBottom = renderLauncher();
    // Centre lands at (366, 782) → bottom is nearest.
    drag(toBottom.button, { x: 850, y: 738 }, { x: 300, y: 760 });
    expect(toBottom.onPositionChange).toHaveBeenCalledWith({ edge: "bottom", offset: 366 / 1000 });
    cleanup();

    const toRight = renderLauncher();
    // Centre lands at (1026, 222) → right is nearest.
    drag(toRight.button, { x: 850, y: 738 }, { x: 960, y: 200 });
    expect(toRight.onPositionChange).toHaveBeenCalledWith({ edge: "right", offset: 222 / 800 });
  });

  it("swallows the click that follows a drag release", () => {
    const { button, onActivate } = renderLauncher();
    drag(button, { x: 850, y: 738 }, { x: 30, y: 400 });
    expect(onActivate).not.toHaveBeenCalled();
    // The suppression is one-shot: the very next click is a real activation.
    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("commits nothing when the gesture is cancelled mid-drag", () => {
    const { button, onPositionChange, onActivate } = renderLauncher();
    fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 860, clientY: 748 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 200 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 100, clientY: 200 });

    expect(onPositionChange).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    expect(button).not.toHaveAttribute("data-dragging");
  });

  it("ignores events from a second pointer during a drag", () => {
    const { button, onPositionChange } = renderLauncher();
    fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 860, clientY: 748 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 100, clientY: 100 });

    // The second finger neither moved nor released the launcher.
    expect(button).not.toHaveAttribute("data-dragging");
    expect(onPositionChange).not.toHaveBeenCalled();
  });
});

describe("Launcher keyboard docking (WCAG 2.5.7)", () => {
  const cases = [
    { key: "{ArrowLeft}", edge: "left" },
    { key: "{ArrowRight}", edge: "right" },
    { key: "{ArrowUp}", edge: "top" },
    { key: "{ArrowDown}", edge: "bottom" },
  ] as const;

  for (const { key, edge } of cases) {
    it(`docks to the ${edge} edge on ${key}, preserving the along-edge offset`, async () => {
      const user = userEvent.setup();
      const { button, onPositionChange, onActivate } = renderLauncher({
        position: { edge: "bottom", offset: 0.42 },
      });
      button.focus();
      await user.keyboard(key);
      expect(onPositionChange).toHaveBeenCalledTimes(1);
      expect(onPositionChange).toHaveBeenCalledWith({ edge, offset: 0.42 });
      expect(onActivate).not.toHaveBeenCalled();
    });
  }

  it("does not let an arrow key reach a global handler", () => {
    const global = vi.fn();
    window.addEventListener("keydown", global);
    try {
      const { button, onPositionChange } = renderLauncher();
      button.focus();
      fireEvent.keyDown(button, { key: "ArrowLeft" });
      expect(onPositionChange).toHaveBeenCalledTimes(1);
      expect(global).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", global);
    }
  });

  it("leaves non-arrow keys alone", async () => {
    const user = userEvent.setup();
    const { button, onPositionChange } = renderLauncher();
    button.focus();
    await user.keyboard("c");
    await user.keyboard("{Escape}");
    expect(onPositionChange).not.toHaveBeenCalled();
  });
});
