/**
 * `./launcher-position` unit tests (vitest + jsdom).
 *
 * Pure arithmetic and one localStorage round trip, so nothing here renders
 * anything. The cases that matter are the degenerate ones — a zero-size
 * viewport, a launcher larger than the window, a persisted value written by
 * an older build — because those are the inputs that turn into `NaNpx` in a
 * stylesheet or a launcher parked off-screen, and neither failure is visible
 * from a happy-path test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LAUNCHER_POSITION,
  edgeForArrowKey,
  LAUNCHER_EDGE_MARGIN_PX,
  launcherPositionStorageKey,
  offsetToPx,
  panelSideForEdge,
  readLauncherPosition,
  snapToEdge,
  writeLauncherPosition,
} from "./launcher-position";

const PREFIX = "r3wr.test";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** A 1000×800 viewport, the fixture every snap test measures against. */
const VIEWPORT = { width: 1000, height: 800 };

describe("snapToEdge", () => {
  it("docks to the nearest edge in each of the four directions", () => {
    // Nearest to the left: 100px from it, 900/400/400 from the others.
    expect(snapToEdge({ x: 100, y: 400 }, VIEWPORT)).toEqual({ edge: "left", offset: 0.5 });
    // Nearest to the right: 60px from it.
    expect(snapToEdge({ x: 940, y: 400 }, VIEWPORT)).toEqual({ edge: "right", offset: 0.5 });
    // Nearest to the top: 20px from it.
    expect(snapToEdge({ x: 500, y: 20 }, VIEWPORT)).toEqual({ edge: "top", offset: 0.5 });
    // Nearest to the bottom: 30px from it.
    expect(snapToEdge({ x: 500, y: 770 }, VIEWPORT)).toEqual({ edge: "bottom", offset: 0.5 });
  });

  it("picks the genuinely nearest edge for a corner-ish point, not the corner's other edge", () => {
    // Bottom-right corner region: 20px above the bottom, 120px left of the
    // right edge. Both edges are "the corner", but bottom is nearer.
    expect(snapToEdge({ x: 880, y: 780 }, VIEWPORT)).toEqual({ edge: "bottom", offset: 0.88 });
    // Same corner, now 40px from the right and 150px from the bottom.
    expect(snapToEdge({ x: 960, y: 650 }, VIEWPORT)).toEqual({ edge: "right", offset: 0.8125 });
  });

  it("breaks exact ties in left, right, top, bottom order", () => {
    // Dead centre of a square viewport: all four distances are 250.
    expect(snapToEdge({ x: 250, y: 250 }, { width: 500, height: 500 }).edge).toBe("left");
    // left (300) ties top (300); right is 700, bottom is 700.
    expect(snapToEdge({ x: 300, y: 300 }, { width: 1000, height: 1000 }).edge).toBe("left");
    // right (200) ties bottom (200); left is 800, top is 800.
    expect(snapToEdge({ x: 800, y: 800 }, { width: 1000, height: 1000 }).edge).toBe("right");
    // top (100) ties bottom (100); left is 400, right is 400.
    expect(snapToEdge({ x: 400, y: 100 }, { width: 800, height: 200 }).edge).toBe("top");
  });

  it("clamps the along-edge offset into 0..1 for points outside the viewport", () => {
    // A drag released off-screen is real — the pointer leaves the window all
    // the time — and the winning edge is then the one it overshot, so the
    // offset being clamped is the PERPENDICULAR overshoot.
    // 100px past the right edge and 100px above the top: right wins on the
    // documented tie-break, and y/height is negative.
    expect(snapToEdge({ x: 1100, y: -100 }, VIEWPORT)).toEqual({ edge: "right", offset: 0 });
    // 100px past the right edge and 100px below the bottom.
    expect(snapToEdge({ x: 1100, y: 900 }, VIEWPORT)).toEqual({ edge: "right", offset: 1 });
    // 50px past the left edge and 100px below the bottom: bottom wins, and
    // x/width is negative.
    expect(snapToEdge({ x: -50, y: 900 }, VIEWPORT)).toEqual({ edge: "bottom", offset: 0 });
  });

  it("returns a finite offset for a zero-size viewport instead of NaN", () => {
    const zero = snapToEdge({ x: 0, y: 0 }, { width: 0, height: 0 });
    expect(zero.offset).toBe(0);
    expect(Number.isNaN(zero.offset)).toBe(false);

    // Only the height collapsed, and a left/right edge wins — so the offset
    // is the one that would divide by zero without the guard.
    const flat = snapToEdge({ x: -10, y: 0 }, { width: 400, height: 0 });
    expect(flat.edge).toBe("left");
    expect(Number.isNaN(flat.offset)).toBe(false);
    expect(flat.offset).toBe(0);
  });
});

describe("offsetToPx", () => {
  const SIZE = { width: 132, height: 44 };

  it("resolves an offset along a normal track, inside the edge margins", () => {
    // Vertical track: 800 - 44 = 756.
    expect(offsetToPx({ edge: "right", offset: 0.5 }, SIZE, VIEWPORT)).toBe(378);
    // Horizontal track: 1000 - 132 = 868.
    expect(offsetToPx({ edge: "top", offset: 0.25 }, SIZE, VIEWPORT)).toBe(217);
  });

  it("keeps the launcher a margin clear of both ends of the track", () => {
    expect(offsetToPx({ edge: "left", offset: 0 }, SIZE, VIEWPORT)).toBe(LAUNCHER_EDGE_MARGIN_PX);
    // Vertical track 756, so the far end is 756 - 18 = 738.
    expect(offsetToPx({ edge: "left", offset: 1 }, SIZE, VIEWPORT)).toBe(738);
    // Horizontal track 868, so the far end is 868 - 18 = 850.
    expect(offsetToPx({ edge: "bottom", offset: 1 }, SIZE, VIEWPORT)).toBe(850);
  });

  it("returns 0 when the launcher is at least as large as the viewport on that axis", () => {
    // Vertical track: 40 - 44 = -4.
    expect(offsetToPx({ edge: "right", offset: 0.5 }, SIZE, { width: 1000, height: 40 })).toBe(0);
    // Exactly zero track, not just negative.
    expect(offsetToPx({ edge: "right", offset: 1 }, SIZE, { width: 1000, height: 44 })).toBe(0);
    // Horizontal track: 100 - 132 = -32.
    expect(offsetToPx({ edge: "top", offset: 1 }, SIZE, { width: 100, height: 800 })).toBe(0);
  });

  it("collapses to the track's midpoint when it is shorter than two margins", () => {
    // Vertical track: 64 - 44 = 20, which cannot hold two 18px margins.
    // `lo` becomes 10 and `hi` is held at `lo` rather than inverting to 2.
    const short = { width: 1000, height: 64 };
    expect(offsetToPx({ edge: "right", offset: 0 }, SIZE, short)).toBe(10);
    expect(offsetToPx({ edge: "right", offset: 0.5 }, SIZE, short)).toBe(10);
    expect(offsetToPx({ edge: "right", offset: 1 }, SIZE, short)).toBe(10);
  });
});

// WP9: the draggable launcher and the panel it opens both dock to a viewport
// edge, so they can land on top of each other — and in the shipped default
// (launcher bottom-right, panel right) they did, over the panel's own
// keyboard-shortcuts strip. `offsetToPx` owns the half of the fix that needs
// the pill's measured width: a launcher travelling the top or bottom edge is
// clamped out of the full-height column the panel occupies. The same-edge
// half is an inset in `overlay.css` and is not observable from here.
describe("offsetToPx with an open panel dock", () => {
  /** A pill wide enough to be realistic; every expected number below is derived from it. */
  const SIZE = { width: 132, height: 44 };
  /** A laptop viewport, comfortably above the narrow breakpoint. */
  const WIDE = { width: 1440, height: 900 };
  /** What `panelDockWidth` reserves at every width in this suite. */
  const PANEL_W = 384;

  it("pulls a bottom-docked launcher out of a right-docked panel's column", () => {
    const pos = { edge: "bottom", offset: 1 } as const;
    // Unclamped, the far end of the 1308px track is one margin in, at 1290 —
    // which puts the pill's right edge at 1422, deep inside a panel whose own
    // left edge is at 1440 - 384 = 1056. That is the defect.
    expect(offsetToPx(pos, SIZE, WIDE)).toBe(1290);

    const clamped = offsetToPx(pos, SIZE, WIDE, { side: "right" });
    expect(clamped).toBe(WIDE.width - PANEL_W - SIZE.width - LAUNCHER_EDGE_MARGIN_PX);
    // Stated as the property that actually matters, not just the number: the
    // pill's whole box ends before the panel's column begins.
    expect(clamped + SIZE.width).toBeLessThanOrEqual(WIDE.width - PANEL_W);
  });

  it("pushes a top-docked launcher off a left-docked panel's column", () => {
    const pos = { edge: "top", offset: 0 } as const;
    // Offset 0 is the near end of the track, which for a LEFT-docked panel is
    // the end that is buried — the mirror image of the case above, and the one
    // that catches the clamp being applied to the wrong bound.
    expect(offsetToPx(pos, SIZE, WIDE)).toBe(LAUNCHER_EDGE_MARGIN_PX);
    expect(offsetToPx(pos, SIZE, WIDE, { side: "left" })).toBe(
      PANEL_W + LAUNCHER_EDGE_MARGIN_PX,
    );
  });

  it("leaves a launcher that is already clear of the column exactly where it was", () => {
    // A quarter of the way along the top edge: 327, right edge 459, nowhere
    // near a panel that starts at 1056. Clamping is not repositioning.
    const clear = { edge: "top", offset: 0.25 } as const;
    expect(offsetToPx(clear, SIZE, WIDE, { side: "right" })).toBe(offsetToPx(clear, SIZE, WIDE));
    // Same on the other side, from the other end of the track.
    const alsoClear = { edge: "bottom", offset: 1 } as const;
    expect(offsetToPx(alsoClear, SIZE, WIDE, { side: "left" })).toBe(
      offsetToPx(alsoClear, SIZE, WIDE),
    );
  });

  it("never constrains a left/right-docked launcher, whose value is a top", () => {
    // The panel is full-height, so there is no clear position along a vertical
    // edge to move to — and the launcher that shares the panel's side is
    // stepped inboard by `overlay.css` instead, on an axis this value does not
    // describe. Either way the answer here must not move.
    for (const edge of ["left", "right"] as const) {
      for (const side of ["left", "right"] as const) {
        for (const offset of [0, 0.5, 1]) {
          expect(offsetToPx({ edge, offset }, SIZE, WIDE, { side })).toBe(
            offsetToPx({ edge, offset }, SIZE, WIDE),
          );
        }
      }
    }
  });

  it("ignores the dock at and below the narrow breakpoint, where the panel is a bottom sheet", () => {
    // A full-width sheet leaves no clear column, and `overlay.css` already
    // lifts the bottom-docked launcher over it vertically. Applying a
    // side-dock offset here as well would push the pill off the side of a
    // phone — so the clamp has to be absent, not merely small.
    const phone = { width: 390, height: 844 };
    const breakpoint = { width: 560, height: 844 };
    for (const viewport of [phone, breakpoint]) {
      for (const side of ["left", "right"] as const) {
        const pos = { edge: "bottom", offset: 1 } as const;
        expect(offsetToPx(pos, SIZE, viewport, { side })).toBe(offsetToPx(pos, SIZE, viewport));
      }
    }
  });

  it("gives up the clearance rather than pushing the launcher off the opposite edge", () => {
    // A 600px window and a 200px pill: the panel's 384px column plus the pill
    // plus a margin does not fit, so there is no position that satisfies both.
    // The launcher must stay reachable — it is how the panel gets closed — so
    // the clearance is what yields.
    const cramped = { width: 600, height: 800 };
    const wide = { width: 200, height: 44 };

    const againstRight = offsetToPx({ edge: "bottom", offset: 1 }, wide, cramped, {
      side: "right",
    });
    expect(againstRight).toBeGreaterThanOrEqual(0);
    expect(againstRight + wide.width).toBeLessThanOrEqual(cramped.width);

    const againstLeft = offsetToPx({ edge: "bottom", offset: 0 }, wide, cramped, { side: "left" });
    expect(againstLeft).toBeGreaterThanOrEqual(0);
    expect(againstLeft + wide.width).toBeLessThanOrEqual(cramped.width);
  });

  it("still returns 0 for a track the launcher cannot fit in at all", () => {
    // The `track <= 0` guard runs before any dock arithmetic, so a dock can
    // never turn a degenerate viewport into a negative inset.
    expect(offsetToPx({ edge: "top", offset: 1 }, SIZE, { width: 100, height: 800 }, {
      side: "right",
    })).toBe(0);
  });
});

describe("panelSideForEdge", () => {
  it("moves the panel left only for a left-docked launcher", () => {
    expect(panelSideForEdge("left")).toBe("left");
    expect(panelSideForEdge("right")).toBe("right");
    expect(panelSideForEdge("top")).toBe("right");
    expect(panelSideForEdge("bottom")).toBe("right");
  });
});

describe("edgeForArrowKey", () => {
  it("maps the four arrow keys to their edges", () => {
    expect(edgeForArrowKey("ArrowLeft")).toBe("left");
    expect(edgeForArrowKey("ArrowRight")).toBe("right");
    expect(edgeForArrowKey("ArrowUp")).toBe("top");
    expect(edgeForArrowKey("ArrowDown")).toBe("bottom");
  });

  it("returns null for anything else, so Enter/Space activation is untouched", () => {
    expect(edgeForArrowKey("Enter")).toBeNull();
    expect(edgeForArrowKey(" ")).toBeNull();
    expect(edgeForArrowKey("a")).toBeNull();
    expect(edgeForArrowKey("Escape")).toBeNull();
    // A key name that collides with `Object.prototype` must not resolve to a
    // truthy lookup on the internal map.
    expect(edgeForArrowKey("constructor")).toBeNull();
  });
});

describe("launcher position storage", () => {
  it("round-trips a written position", () => {
    writeLauncherPosition(PREFIX, { edge: "top", offset: 0.25 });
    expect(window.localStorage.getItem(launcherPositionStorageKey(PREFIX))).toBe(
      '{"edge":"top","offset":0.25}',
    );
    expect(readLauncherPosition(PREFIX)).toEqual({ edge: "top", offset: 0.25 });
  });

  it("namespaces the key under the caller's storage prefix", () => {
    expect(launcherPositionStorageKey("acme.review")).toBe("acme.review.launcher");
  });

  it("falls back to the default when nothing was ever written", () => {
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
    expect(DEFAULT_LAUNCHER_POSITION).toEqual({ edge: "right", offset: 1 });
  });

  it("falls back to the default when the stored JSON is malformed", () => {
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), "{not json");
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
  });

  it("falls back to the default when the payload isn't an object at all", () => {
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), "null");
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), '"right"');
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), "42");
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
  });

  it("falls back to the default when `edge` is not one of the four literals", () => {
    window.localStorage.setItem(
      launcherPositionStorageKey(PREFIX),
      '{"edge":"middle","offset":0.5}',
    );
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), '{"offset":0.5}');
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
  });

  it("falls back to the default when `offset` is not a finite number", () => {
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), '{"edge":"top"}');
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), '{"edge":"top","offset":"0.5"}');
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
    // `JSON.stringify` turns NaN/Infinity into `null`, which is the shape an
    // older build with unguarded arithmetic would actually have persisted.
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), '{"edge":"top","offset":null}');
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
  });

  it("clamps a valid-but-out-of-range offset rather than discarding the position", () => {
    window.localStorage.setItem(launcherPositionStorageKey(PREFIX), '{"edge":"left","offset":1.4}');
    expect(readLauncherPosition(PREFIX)).toEqual({ edge: "left", offset: 1 });
    window.localStorage.setItem(
      launcherPositionStorageKey(PREFIX),
      '{"edge":"bottom","offset":-3}',
    );
    expect(readLauncherPosition(PREFIX)).toEqual({ edge: "bottom", offset: 0 });
  });

  it("falls back to the default when reading storage throws (private mode)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    expect(readLauncherPosition(PREFIX)).toEqual(DEFAULT_LAUNCHER_POSITION);
  });

  it("silently no-ops when writing storage throws", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeLauncherPosition(PREFIX, { edge: "top", offset: 0.5 })).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(1);
  });
});
