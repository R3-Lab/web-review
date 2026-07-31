/**
 * `.r3wr-panel`'s geometry, as numbers, in exactly one place.
 *
 * The panel is laid out entirely by `./overlay.css`: a 384px column pinned to
 * one side of the viewport, capped at 94vw, that stops being a column at all
 * below 560px and becomes a full-width bottom sheet. None of that needs
 * JavaScript. But two other surfaces have to stay OUT of the column the panel
 * occupies, and neither of them can ask the DOM where it is:
 *
 *  - `./composer` clamps the draft form so its submit button never lands
 *    underneath the panel.
 *  - `./launcher-position` clamps a top/bottom-docked launcher along its edge
 *    for the same reason. The defect that produced this module was the
 *    default bottom-right launcher sitting on top of the panel's own
 *    keyboard-shortcuts strip, swallowing text a reviewer has to be able to
 *    read.
 *
 * Measuring the real `.r3wr-panel` would be worse, not better. Both callers
 * run while the panel is still animating in (`r3wr-slide-in`), so a live
 * measurement is a moving target; and the composer needs an answer for a
 * panel that is SHUT, where "how much room would it take" has no DOM to read
 * at all.
 *
 * So the numbers are mirrored from CSS — and this module exists so that they
 * are mirrored once rather than once per caller. The CSS side of the same
 * single source is the `--r3wr-panel-w` custom property, which `.r3wr-panel`
 * and the launcher's step-inboard rules both read; a change to either side
 * has to be made to the other.
 */

/** `.r3wr-panel`'s docked width. Mirrors its `width: var(--r3wr-panel-w)`. */
export const PANEL_WIDTH_PX = 384;

/** The cap that binds on viewports too narrow for the full width. Mirrors the `94vw` term. */
export const PANEL_MAX_WIDTH_VW = 0.94;

/**
 * At and below this width the panel is a full-width bottom sheet rather than
 * a side dock. Mirrors `overlay.css`'s `@media (max-width: 560px)`.
 */
export const PANEL_NARROW_BREAKPOINT_PX = 560;

/**
 * How much horizontal space an open panel occupies at this viewport width, or
 * 0 when it occupies none.
 *
 * WHICH side that column sits on is not this function's business: the panel
 * follows the launcher and can dock either way (`panelSideForEdge` in
 * `./launcher-position`), and the width is the same either way. Each caller
 * applies the number to whichever bound `panelSide` names — getting that
 * wrong doesn't merely fail to help, it pushes the thing being clamped
 * straight under the panel it was supposed to avoid.
 *
 * Below the breakpoint the answer is 0 rather than "the whole viewport": the
 * bottom sheet spans the full width, so there is no clear column left to move
 * anything into, and the two surfaces that avoid it there avoid it
 * VERTICALLY instead — `overlay.css` lifts the bottom-docked launcher above
 * the sheet and caps the composer's height. Returning 0 is what keeps this
 * module from double-applying a side-dock offset on top of those rules.
 *
 * The `94vw` cap is carried faithfully from the stylesheet even though it
 * cannot bind as the numbers currently stand — it only wins below ~408px,
 * which is already deep inside the range this returns 0 for. It stays because
 * moving the breakpoint should be a one-line change here rather than a silent
 * geometry bug, and because a term this function drops is a term that has
 * quietly stopped mirroring the CSS.
 */
export function panelDockWidth(viewportWidth: number): number {
  if (viewportWidth <= PANEL_NARROW_BREAKPOINT_PX) return 0;
  return Math.min(PANEL_WIDTH_PX, viewportWidth * PANEL_MAX_WIDTH_VW);
}
