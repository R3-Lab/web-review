"use client";

/**
 * `Launcher` — the fixed "Review" pill, draggable to any viewport edge.
 *
 * This is the only chrome the overlay shows before a reviewer has done
 * anything, and until now it was nailed to the bottom-right corner. That
 * corner is contested territory on real sites (chat widgets, cookie banners,
 * "back to top" buttons), and a reviewer who cannot move the launcher cannot
 * review whatever it is covering. So the pill can be dragged, and on release
 * it docks to the nearest edge — see `./launcher-position` for why the model
 * is an edge plus a fraction rather than a raw pixel pair.
 *
 * Design decisions worth stating, because they are not obvious from the code:
 *
 *  - **This component is stateless about persistence.** It renders the
 *    `position` it is handed and reports a new one through
 *    `onPositionChange`; the host owns storage. That keeps the component
 *    testable without localStorage and lets the host decide when a position
 *    is worth writing.
 *  - **`LauncherProps` is declared here, not imported from `./overlay-root`.**
 *    The other overlay surfaces implement seams that `overlay-root` owns
 *    (`PanelRenderProps` and friends), but the launcher is the opposite
 *    shape: it is a leaf that knows nothing about gates, threads, or panels.
 *    `variant` collapses everything it would otherwise need to know about the
 *    access gate into three rendering cases.
 *  - **Pointer events, tracked on `window`, not pointer capture.** A drag has
 *    to keep working once the pointer leaves the 132px pill — which it does
 *    immediately — and `setPointerCapture` is unimplemented in jsdom, so
 *    window listeners are both the more portable and the more testable
 *    choice.
 *  - **A press is a click until proven otherwise.** Nothing happens until the
 *    pointer has travelled more than `LAUNCHER_DRAG_THRESHOLD_PX`; below that
 *    the press is an ordinary click and `onActivate` fires. Activation is
 *    deliberately left to the native `click` event rather than being
 *    synthesised from `pointerup`, so Enter/Space keep working for free.
 *  - **Arrow keys move the launcher too** (WCAG 2.5.7, Dragging Movements) —
 *    no drag-only action may exist without a non-drag alternative.
 *  - **An open panel is an obstacle, not just a state.** Being draggable to
 *    any edge put the pill in reach of the panel it opens, and the two
 *    collide in the default arrangement: both dock right, and the panel's
 *    keyboard-shortcuts strip lives exactly where the launcher sits. `dock`
 *    is how the host tells this component the panel is up and on which side;
 *    `offsetToPx` uses it to keep a top/bottom-docked pill out of the panel's
 *    column. The launcher is never hidden for this — it is the control that
 *    closes the panel, so it has to stay both visible and reachable.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { KeyRoundIcon, MessageSquarePlusIcon } from "./icons";
import {
  edgeForArrowKey,
  LAUNCHER_DRAG_THRESHOLD_PX,
  offsetToPx,
  snapToEdge,
} from "./launcher-position";
import type { LauncherPosition, PanelDock } from "./launcher-position";

/**
 * The pill's size before it has ever been measured, used for exactly one
 * paint. Taken from the rendered "Review" button at the current type scale:
 * a 16px glyph + 8px gap + the word, inside 16px of horizontal padding, at
 * the 44px minimum touch height `overlay.css` gives it. The first paint
 * would otherwise position a zero-size box, which on the bottom edge is a
 * visible jump of a full button height.
 */
const LAUNCHER_FALLBACK_SIZE = { width: 132, height: 44 };

export interface LauncherProps {
  /** Current docked position. The component never touches storage; the host persists. */
  position: LauncherPosition;
  /** Called once, on drag release or an arrow-key move, with the new snapped position. */
  onPositionChange: (next: LauncherPosition) => void;
  /** Spread onto every node this component renders — carries `OVERLAY_ATTR`. */
  tag: Record<string, string>;
  /** Which launcher this is: the access gate's states, or the working review button. */
  variant: "checking" | "locked" | "unlocked";
  /** Open-thread count badge. Rendered only when > 0 and `variant === "unlocked"`. */
  count?: number;
  /** Whether the surface this launcher opens is currently open — drives `aria-expanded`. */
  expanded: boolean;
  /** A real activation: a press that never became a drag. */
  onActivate: () => void;
  /** The button's accessible name. */
  label: string;
  /**
   * The open panel's dock, so a launcher travelling along the top or bottom
   * edge stays out of the column it occupies. Absent while the panel is shut,
   * which is also what tells `offsetToPx` there is nothing to avoid. The
   * same-edge case (pill and panel on the same side) is handled by
   * `overlay.css` instead — see `offsetToPx` for the split.
   */
  dock?: PanelDock;
}

/** What the launcher measured itself, and the viewport, to be. */
interface Metrics {
  size: { width: number; height: number };
  viewport: { width: number; height: number };
}

/**
 * A press in flight. Lives in a ref rather than state because the
 * `pointermove`/`pointerup` handlers must see the values written by
 * `pointerdown` in the same gesture, not whatever a render cycle has caught
 * up to — and because `moved` flipping should not itself cost a render.
 */
interface DragSession {
  /** Only this pointer's events count; a second finger must not steer the drag. */
  pointerId: number;
  /** Pointer position at press, in viewport coords — the threshold's origin. */
  originX: number;
  originY: number;
  /** Where inside the pill the grab landed, so it doesn't jump under the cursor. */
  grabX: number;
  grabY: number;
  /** The pill's size at press, used to find its centre on release. */
  width: number;
  height: number;
  /** True once the pointer has travelled past the threshold: this is a drag. */
  moved: boolean;
}

/**
 * Swallow the one `click` the browser fires after a drag release, so letting
 * go of the launcher never also presses it.
 *
 * Capture phase on `window`, so it runs before any handler on the button (or
 * on whatever host element the pointer happened to be over when it was
 * released — that element must not be activated either). It removes itself
 * the moment it fires; the 0ms timeout is the fallback for the case where no
 * click ever arrives, so the listener can never linger into the next gesture.
 */
function suppressNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener("click", swallow, true);
  };
  window.addEventListener("click", swallow, true);
  window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

export function Launcher({
  position,
  onPositionChange,
  tag,
  variant,
  count,
  expanded,
  onActivate,
  label,
  dock,
}: LauncherProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);

  // `pressed` exists to drive the effect that owns the window listeners:
  // they must be attached for exactly the life of one gesture. `dragBox` is
  // the inline viewport-coord top-left while the pointer is genuinely
  // dragging, and `null` at every other moment — including during a press
  // that has not yet crossed the threshold, which must still look and behave
  // like a docked button.
  const [pressed, setPressed] = useState(false);
  const [dragBox, setDragBox] = useState<{ left: number; top: number } | null>(null);

  const measure = useCallback((): Metrics => {
    const rect = buttonRef.current?.getBoundingClientRect();
    return {
      // A zero-size rect means "not laid out yet" (or a test environment with
      // no layout engine), not "a zero-size button" — fall back rather than
      // compute a track against a size that cannot be real.
      size: {
        width: rect && rect.width > 0 ? rect.width : LAUNCHER_FALLBACK_SIZE.width,
        height: rect && rect.height > 0 ? rect.height : LAUNCHER_FALLBACK_SIZE.height,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, []);

  const [metrics, setMetrics] = useState<Metrics>(measure);

  // Correct the fallback to the real rendered size before the browser paints.
  // Deliberately has no dependency array — the pill's width changes with its
  // own content (the count badge appearing, the label growing) and there is
  // no cheaper signal for that than re-checking each render. The equality
  // guard is what stops that from looping.
  useLayoutEffect(() => {
    setMetrics((prev) => {
      const next = measure();
      return sameMetrics(prev, next) ? prev : next;
    });
  });

  // A resize changes the track length without re-rendering anything on its
  // own, so it needs its own listener; `offsetToPx` would otherwise keep
  // resolving the offset against the old viewport.
  useEffect(() => {
    const onResize = () => setMetrics(measure());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  // The gesture's window listeners. Mounted only while a press is in flight
  // so the overlay isn't holding three global listeners for the 99.9% of its
  // life when nobody is touching the launcher. `pointerdown` is a discrete
  // event, so React flushes `setPressed(true)` before the browser delivers
  // the next pointer event and this effect is always attached in time.
  useEffect(() => {
    if (!pressed) return;

    /** End the gesture, whatever the reason. */
    const finish = (session: DragSession) => {
      dragRef.current = null;
      setPressed(false);
      setDragBox(null);
      // Only a real drag has a click to swallow; a press below the threshold
      // IS the click, and suppressing it would break activation entirely.
      if (session.moved) suppressNextClick();
    };

    const onMove = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      if (!session.moved) {
        const dx = event.clientX - session.originX;
        const dy = event.clientY - session.originY;
        if (Math.hypot(dx, dy) <= LAUNCHER_DRAG_THRESHOLD_PX) return;
        session.moved = true;
      }
      // Track both axes freely while the pointer is down — the snap only
      // happens on release, so the reviewer can see where they are aiming.
      setDragBox({
        left: event.clientX - session.grabX,
        top: event.clientY - session.grabY,
      });
    };

    const onUp = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      const moved = session.moved;
      finish(session);
      if (!moved) return;
      // Snap on the pill's CENTRE, not the pointer: a pill grabbed by one
      // end and released near an edge should dock to the edge it visually
      // sits against, which is a question about the box, not the cursor.
      const left = event.clientX - session.grabX;
      const top = event.clientY - session.grabY;
      onPositionChange(
        snapToEdge(
          { x: left + session.width / 2, y: top + session.height / 2 },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };

    const onCancel = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session || event.pointerId !== session.pointerId) return;
      // A cancelled gesture (the OS took over, the browser started a scroll)
      // commits nothing — the launcher springs back to where it was.
      finish(session);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [pressed, onPositionChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Secondary buttons open context menus and paste on Linux; neither should
    // pick the launcher up.
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      width: rect.width || LAUNCHER_FALLBACK_SIZE.width,
      height: rect.height || LAUNCHER_FALLBACK_SIZE.height,
      moved: false,
    };
    setPressed(true);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const edge = edgeForArrowKey(event.key);
    // Anything that isn't an arrow is somebody else's key — in particular
    // Enter and Space, which must still activate the button.
    if (!edge) return;
    event.preventDefault();
    // React's `stopPropagation` stops the native event too, which is the
    // point: neither the host page nor `OverlayRoot`'s own global keydown
    // handler should see an arrow that was aimed at the launcher.
    event.stopPropagation();
    onPositionChange({ edge, offset: position.offset });
  };

  const style = {
    "--r3wr-launcher-pos": `${offsetToPx(position, metrics.size, metrics.viewport, dock)}px`,
    // While dragging, inline left/top beat the stylesheet's docked insets;
    // `overlay.css`'s `[data-dragging="true"]` rule resets the other two
    // (`right`/`bottom`) to `auto` so the box isn't stretched between them.
    ...(dragBox ? { left: `${dragBox.left}px`, top: `${dragBox.top}px` } : null),
  } as CSSProperties;

  const showCount = variant === "unlocked" && (count ?? 0) > 0;

  return (
    <button
      ref={buttonRef}
      type="button"
      className="r3wr-toggle"
      data-edge={position.edge}
      // `"true"` for `checking` as well as `locked`, because this attribute
      // answers "is this the gate's button?", not "did the probe finish?" —
      // and while the gate is still checking, the launcher IS the gate's
      // button. That is the contract the DOM this replaces already had, and
      // the example app's Playwright helpers read
      // `.r3wr-toggle[data-locked='true']` exactly that way. Absent, never
      // `"false"`, for `unlocked`: the CSS and those same helpers select on
      // `.r3wr-toggle:not([data-locked])` to mean "the working launcher".
      data-locked={variant === "unlocked" ? undefined : "true"}
      data-dragging={dragBox ? "true" : undefined}
      {...tag}
      style={style}
      disabled={variant === "checking"}
      aria-expanded={expanded}
      aria-label={label}
      aria-haspopup={variant === "locked" ? "dialog" : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={onActivate}
    >
      {variant === "unlocked" ? (
        <MessageSquarePlusIcon size={16} {...tag} />
      ) : (
        <KeyRoundIcon size={16} {...tag} />
      )}
      <span {...tag}>Review</span>
      {showCount && (
        <span className="r3wr-toggle-count" {...tag} aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  );
}

/** Metrics equality, so the measuring layout effect can bail without re-rendering. */
function sameMetrics(a: Metrics, b: Metrics): boolean {
  return (
    a.size.width === b.size.width &&
    a.size.height === b.size.height &&
    a.viewport.width === b.viewport.width &&
    a.viewport.height === b.viewport.height
  );
}
