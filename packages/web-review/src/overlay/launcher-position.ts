/**
 * Where the review launcher sits, as a value.
 *
 * The launcher used to be hard-pinned to the bottom-right corner by CSS, and
 * that corner is exactly where a lot of host sites already put THEIR floating
 * chrome — cookie banners, chat widgets, "back to top" buttons. A reviewer
 * who cannot move the launcher cannot review the thing underneath it, so the
 * button is now draggable. It is deliberately NOT free-floating: on release
 * it snaps to the nearest viewport edge and remembers only which edge it
 * chose plus how far along that edge it sits. Two reasons for that model
 * rather than storing raw x/y:
 *
 *  - A launcher parked in the middle of the page is a worse overlay than one
 *    that never moved; docking to an edge keeps it out of the content the
 *    reviewer is actually looking at, no matter where they let go.
 *  - An edge + a 0..1 fraction survives a viewport resize (or a different
 *    machine reading the same persisted value) without ever landing
 *    off-screen, which a stored pixel pair cannot promise.
 *
 * This module is the whole model: the shape, its storage round trip, and the
 * pure geometry the component and the CSS need. Nothing here touches the DOM
 * beyond `window.localStorage`, so all of it is directly testable — which
 * matters, because the snap/clamp arithmetic is where this feature's real
 * edge cases live (zero-size viewports, a launcher wider than the window, an
 * offset that was valid when it was written and isn't now).
 *
 * `edgeForArrowKey` lives here rather than inline in the component for a
 * reason worth stating: WCAG 2.5.7 (Dragging Movements) requires a non-drag
 * path to anything a drag can do, so the keyboard alternative is part of the
 * model's contract, not a convenience the UI layer happens to offer.
 *
 * The storage helpers mirror `./helpers.ts`'s `readShowHighlights` /
 * `writeShowHighlights` exactly — same try/catch, same "a broken value is
 * indistinguishable from no value" posture. Private-mode browsers throw on
 * `localStorage` access; a review overlay must degrade to its default
 * position there, never blow up on the host page.
 *
 * One piece of geometry here is not about the launcher alone: `offsetToPx`
 * also keeps the pill out of the OPEN panel's column. That is a collision the
 * draggable launcher created — the panel used to be the only thing docked to
 * an edge — and it is only half the fix. See `offsetToPx` for why this half
 * lives in JavaScript and the other half lives in `overlay.css`.
 */

import { panelDockWidth } from "./panel-geometry";

/** Which viewport edge the launcher is docked against. */
export type LauncherEdge = "left" | "right" | "top" | "bottom";

/** Which side of the viewport the panel the launcher opens should dock to. */
export type PanelSide = "left" | "right";

/**
 * The open panel, as much of it as the launcher's geometry needs to know.
 *
 * A dock is a full-height column against one side of the viewport, so the
 * only thing that varies is which side; how wide the column is at the current
 * viewport width is `panelDockWidth`'s answer (`./panel-geometry`), not the
 * caller's — a caller that had to supply the width could disagree with the
 * stylesheet, which is the whole failure mode that module exists to prevent.
 *
 * An object rather than a bare {@link PanelSide} so the call sites read as
 * "the dock to avoid" rather than as a fourth positional coordinate.
 */
export interface PanelDock {
  /** Which side of the viewport the open panel occupies. */
  side: PanelSide;
}

export interface LauncherPosition {
  /** Which viewport edge the launcher is docked against. */
  edge: LauncherEdge;
  /**
   * 0..1 fractional position ALONG that edge.
   * left/right edges: 0 = top of the viewport, 1 = bottom.
   * top/bottom edges: 0 = left of the viewport, 1 = right.
   */
  offset: number;
}

/** Bottom of the right edge — reproduces the launcher's historical bottom-right corner. */
export const DEFAULT_LAUNCHER_POSITION: LauncherPosition = { edge: "right", offset: 1 };

/** Gap kept between the launcher and the two ends of the edge it sits on. */
export const LAUNCHER_EDGE_MARGIN_PX = 18;

/**
 * Pointer travel (px) before a press becomes a drag rather than a click.
 * Small enough that a deliberate drag registers immediately, large enough
 * that the hand tremor in an ordinary click never costs someone the click.
 */
export const LAUNCHER_DRAG_THRESHOLD_PX = 5;

/** The localStorage key holding the persisted launcher position. */
export function launcherPositionStorageKey(prefix: string): string {
  return `${prefix}.launcher`;
}

/** The four valid edges, as a runtime set — the type alone can't validate parsed JSON. */
const EDGES: readonly LauncherEdge[] = ["left", "right", "top", "bottom"];

function isLauncherEdge(value: unknown): value is LauncherEdge {
  return typeof value === "string" && (EDGES as readonly string[]).includes(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Fraction of `total` that `value` represents, or 0 when `total` is not a
 * usable length. A zero-width/height viewport is not hypothetical — it is
 * what a headless render, a display:none iframe, or a window mid-restore
 * reports — and `0 / 0` is `NaN`, which would poison every downstream
 * calculation and end up in the stylesheet as `NaNpx`.
 */
function fractionOf(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

/**
 * The persisted launcher position, or {@link DEFAULT_LAUNCHER_POSITION}.
 *
 * Every failure mode collapses to the default: no key, storage that throws,
 * malformed JSON, an `edge` that isn't one of the four literals, an `offset`
 * that isn't a finite number. An offset that IS a finite number but sits
 * outside 0..1 is treated differently — it is clamped rather than rejected,
 * since the intent behind "1.4" is unambiguous (the far end of that edge) and
 * throwing the whole position away over it would move a launcher the reviewer
 * deliberately parked.
 */
export function readLauncherPosition(prefix: string): LauncherPosition {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(launcherPositionStorageKey(prefix));
  } catch {
    return DEFAULT_LAUNCHER_POSITION;
  }
  if (!raw) return DEFAULT_LAUNCHER_POSITION;

  let parsed: { edge?: unknown; offset?: unknown } | null;
  try {
    // The assertion is a claim about SHAPE only; both fields are validated
    // below, so a payload that parses to a number, a string, or an object of
    // some entirely different shape reads as `undefined` here and falls
    // through to the default rather than escaping as a bad position.
    parsed = JSON.parse(raw) as { edge?: unknown; offset?: unknown } | null;
  } catch {
    return DEFAULT_LAUNCHER_POSITION;
  }
  if (!parsed) return DEFAULT_LAUNCHER_POSITION;

  const { edge, offset } = parsed;
  if (!isLauncherEdge(edge)) return DEFAULT_LAUNCHER_POSITION;
  if (typeof offset !== "number" || !Number.isFinite(offset)) return DEFAULT_LAUNCHER_POSITION;
  return { edge, offset: clamp01(offset) };
}

/** Persist the launcher position. Silently no-ops when storage throws. */
export function writeLauncherPosition(prefix: string, pos: LauncherPosition): void {
  try {
    window.localStorage.setItem(launcherPositionStorageKey(prefix), JSON.stringify(pos));
  } catch {
    // Storage unavailable; the position stays in memory for this session.
  }
}

/**
 * The docked position nearest to `point` — the whole "never floats in the
 * middle" rule, in one function.
 *
 * `point` is the launcher's CENTER in viewport coordinates, not the pointer:
 * snapping on the pointer would send a pill grabbed by its right end to the
 * wrong edge whenever the grab offset was larger than the distance to the
 * nearer edge.
 *
 * Candidates are evaluated left, right, top, bottom and the comparison is
 * STRICTLY less-than, so an exact tie (the dead centre of a square viewport
 * ties all four) resolves to the earlier entry in that order. That is an
 * arbitrary but fixed rule; what matters is that it is deterministic, since a
 * tie-break that flickered between two edges on identical input would make
 * the launcher feel broken.
 */
export function snapToEdge(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): LauncherPosition {
  let edge: LauncherEdge = "left";
  let distance = point.x;
  const consider = (candidate: LauncherEdge, candidateDistance: number) => {
    if (candidateDistance < distance) {
      edge = candidate;
      distance = candidateDistance;
    }
  };
  consider("right", viewport.width - point.x);
  consider("top", point.y);
  consider("bottom", viewport.height - point.y);

  const along =
    edge === "left" || edge === "right"
      ? fractionOf(point.y, viewport.height)
      : fractionOf(point.x, viewport.width);
  return { edge, offset: clamp01(along) };
}

/**
 * `pos.offset` resolved to a pixel distance along its edge, measured from the
 * edge's start (top for left/right, left for top/bottom) to the launcher's
 * near corner — i.e. exactly what the stylesheet wants for `top` or `left`.
 *
 * The usable track is the viewport minus the launcher's own extent on that
 * axis, so `offset: 1` puts the FAR corner of the pill on the far end of the
 * edge rather than pushing the pill off-screen.
 *
 * Both guards below exist for viewports too small to satisfy the margins:
 *  - `track <= 0` means the launcher is longer than the viewport on this
 *    axis (a phone in landscape, a tiny embedded frame). There is no valid
 *    position, so it goes flush to the start rather than negative.
 *  - `Math.min`/`Math.max` around the margins keep `[lo, hi]` from inverting
 *    when the track is shorter than two margins; without them a 20px track
 *    would produce the range [18, 2] and the clamp would return garbage.
 *
 * `dock` — supplied only while the panel is OPEN — narrows the track further
 * so a top/bottom-docked launcher never enters the column the panel occupies.
 * Three things about that are worth stating outright:
 *
 *  - **Why it is needed at all.** The panel is full-height, so a launcher
 *    sliding along the top or bottom edge is inside the panel's vertical span
 *    for its whole travel; only its position on the horizontal axis can keep
 *    it clear. The overlap is not cosmetic — the panel's keyboard-shortcuts
 *    strip is pinned to its bottom edge, exactly where the default launcher
 *    sits, and the pill swallowed a line of it.
 *  - **Why this half is here and not in the stylesheet.** The clamp needs the
 *    pill's measured WIDTH, which grows with its label and its count badge
 *    and which no CSS rule can know. The mirror-image case — a launcher
 *    docked to the SAME side as the panel — needs no measurement, just a
 *    bigger inset, so `overlay.css` handles it there, where it can compose
 *    with `env(safe-area-inset-*)` that JavaScript cannot read.
 *  - **Why a dock never moves a left/right-docked launcher.** The value
 *    returned for those edges is a `top`, and a full-height column does not
 *    leave a clear position anywhere along a vertical edge. Nothing to clamp.
 *
 * A dock-adjusted bound is honoured only as far as the un-docked bounds
 * allow. On a viewport too narrow to hold the panel and the pill side by side
 * the clearance is given up rather than pushed past the opposite edge: a
 * launcher overlapping the panel is a smaller failure than one nobody can
 * reach, and the launcher is how the panel gets closed again.
 */
export function offsetToPx(
  pos: LauncherPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  dock?: PanelDock,
): number {
  const alongVerticalEdge = pos.edge === "left" || pos.edge === "right";
  const track = alongVerticalEdge ? viewport.height - size.height : viewport.width - size.width;
  if (track <= 0) return 0;
  let lo = Math.min(LAUNCHER_EDGE_MARGIN_PX, track / 2);
  let hi = Math.max(track - LAUNCHER_EDGE_MARGIN_PX, lo);

  if (dock && !alongVerticalEdge) {
    // 0 below the narrow breakpoint, where the panel is a bottom sheet and
    // `overlay.css` already lifts the launcher clear of it vertically —
    // that is what stops this from double-applying an offset there.
    const dockWidth = panelDockWidth(viewport.width);
    if (dockWidth > 0) {
      // `track` already has the pill's width subtracted, so `track - dockWidth`
      // is the far end of the usable travel with the column removed — i.e.
      // the largest `left` that still leaves the whole pill outside it.
      if (dock.side === "right") {
        hi = Math.max(lo, Math.min(hi, track - dockWidth - LAUNCHER_EDGE_MARGIN_PX));
      } else {
        lo = Math.min(hi, Math.max(lo, dockWidth + LAUNCHER_EDGE_MARGIN_PX));
      }
    }
  }

  return Math.min(Math.max(pos.offset * track, lo), hi);
}

/**
 * Which side the panel the launcher opens should dock to, given where the
 * launcher is.
 *
 * The panel must not cover the button the reviewer just pressed, and a
 * left-docked launcher is the only arrangement that creates that collision —
 * a top- or bottom-docked launcher clears a right-docked panel either way,
 * because the panel is a tall narrow column and the launcher is a short wide
 * pill sitting off its end. So this is not "mirror the launcher"; it is "move
 * the panel only when staying put would hide the launcher".
 */
export function panelSideForEdge(edge: LauncherEdge): PanelSide {
  return edge === "left" ? "left" : "right";
}

/**
 * Arrow keys → the edge they dock to. Everything else is left alone.
 *
 * A `Map` rather than an object literal on purpose: this is keyed by
 * arbitrary `KeyboardEvent.key` strings, and an object lookup would resolve
 * `"constructor"` (and every other `Object.prototype` member) to a truthy
 * value that is not an edge.
 */
const ARROW_KEY_EDGES = new Map<string, LauncherEdge>([
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "top"],
  ["ArrowDown", "bottom"],
]);

/**
 * The edge an arrow key docks the launcher to, or `null` for any other key.
 *
 * This is the WCAG 2.5.7 (Dragging Movements) alternative: every edge the
 * launcher can be dragged to is reachable with a single keypress while the
 * button has focus. Returning `null` rather than throwing for other keys is
 * what lets the component treat "not an arrow" as "not ours" and leave
 * Enter/Space activation completely untouched.
 */
export function edgeForArrowKey(key: string): LauncherEdge | null {
  return ARROW_KEY_EDGES.get(key) ?? null;
}
