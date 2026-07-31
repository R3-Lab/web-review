/**
 * `./panel-geometry` unit tests (vitest).
 *
 * One branch and three constants, so the arithmetic is not what is worth
 * asserting — the boundaries are. Two of them matter:
 *
 *  - The narrow breakpoint, where the panel stops being a column and the
 *    answer has to collapse to 0. Every caller adds this number to an inset,
 *    so a non-zero answer down there would stack a side-dock offset on top of
 *    `overlay.css`'s bottom-sheet rules and shove the launcher off the side of
 *    a phone.
 *  - The `94vw` cap, which the module carries from CSS but which cannot bind
 *    at the current breakpoint. That is asserted rather than assumed, because
 *    it is exactly the kind of fact that stops being true when someone moves
 *    the breakpoint and reads as a mystery afterwards.
 */

import { describe, expect, it } from "vitest";

import {
  PANEL_MAX_WIDTH_VW,
  PANEL_NARROW_BREAKPOINT_PX,
  PANEL_WIDTH_PX,
  panelDockWidth,
} from "./panel-geometry";

describe("panelDockWidth", () => {
  it("reserves the panel's full width on an ordinary desktop viewport", () => {
    expect(panelDockWidth(1440)).toBe(PANEL_WIDTH_PX);
    expect(panelDockWidth(1280)).toBe(PANEL_WIDTH_PX);
  });

  it("reserves nothing at or below the narrow breakpoint, where the panel is a bottom sheet", () => {
    expect(panelDockWidth(PANEL_NARROW_BREAKPOINT_PX)).toBe(0);
    expect(panelDockWidth(PANEL_NARROW_BREAKPOINT_PX - 1)).toBe(0);
    expect(panelDockWidth(375)).toBe(0);
    // A viewport with no width at all (a headless render, a display:none
    // frame) must not produce a negative or NaN reservation either.
    expect(panelDockWidth(0)).toBe(0);
  });

  it("switches over on the first pixel past the breakpoint, matching the CSS media query", () => {
    expect(panelDockWidth(PANEL_NARROW_BREAKPOINT_PX + 1)).toBe(PANEL_WIDTH_PX);
  });

  it("keeps the vw cap from ever binding at the current breakpoint", () => {
    // The cap only wins below PANEL_WIDTH_PX / PANEL_MAX_WIDTH_VW ≈ 408px,
    // which is already inside the bottom-sheet range. So every non-zero
    // answer this function can give is the flat width — the property the
    // `overlay.css` rules that add `--r3wr-panel-w` to an inset rely on.
    expect(PANEL_WIDTH_PX / PANEL_MAX_WIDTH_VW).toBeLessThan(PANEL_NARROW_BREAKPOINT_PX);
    for (const width of [561, 600, 768, 1024, 1440, 2560]) {
      expect(panelDockWidth(width)).toBe(PANEL_WIDTH_PX);
    }
  });
});
