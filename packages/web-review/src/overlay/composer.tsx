"use client";

/**
 * `Composer` — the pin-drop draft form: category picker, title, body,
 * reviewer-name capture, screenshot status, submit/cancel. Plugs into
 * `OverlayRoot` via `renderComposer` (see `./overlay-root`'s
 * `ComposerRenderProps`).
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * `Composer` (~1128-1388), generalized:
 *  - the four hardcoded categories become `config.categories` — the picker
 *    renders whatever the consumer configured, in that order;
 *  - a 401 from `onSubmit` is recovered inline via `config.adapter.unlock`
 *    (through the shared `PasswordForm`, `./unlock-dialog`) rather than a
 *    fixed `unlock()` import.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import { isLocked } from "../core/adapter";
import type { Anchor, AnchorKind, ReviewCategoryDef } from "../core/types";
import { useFocusTrap } from "../client/use-focus-trap";
import type { ComposerRenderProps } from "./overlay-root";
import type { PanelSide } from "./launcher-position";
import { CategoryIcon, CircleAlertIcon, XIcon } from "./icons";
import { categoryAccent, resolveCategory } from "./helpers";
import { panelDockWidth } from "./panel-geometry";
import { PasswordForm } from "./unlock-dialog";

const TAG = { [OVERLAY_ATTR]: "" } as const;

/**
 * A text pin is almost always a copy note, so the picker starts there;
 * anything else starts on the design category. Falls back to whatever the
 * consumer's first configured category is when their custom set doesn't
 * include the preferred id — a fully custom category list must still land
 * on a valid, pre-selected radio rather than nothing checked.
 */
function defaultCategoryId(categories: ReviewCategoryDef[], kind: AnchorKind | undefined): string {
  const preferred = kind === "text" ? "copy" : "design";
  return categories.find((c) => c.id === preferred)?.id ?? categories[0]?.id ?? preferred;
}

// ─────────────────────── on-screen position clamping ─────────────────────
// Two axes, two different bugs (WP21): horizontally the clamp didn't know
// `.r3wr-panel` exists at all; vertically it clamped against a flat 160px
// guess when real content runs ~450-550px. Both are fixed by clamping
// against the composer's REAL right/bottom-edge limits — the panel's actual
// reserved width, and the composer's actual measured height — rather than
// guessing either.

/**
 * First-paint fallback for the composer's own rendered height, used only
 * until the `useLayoutEffect` below measures the real thing — which it does
 * before the browser paints, so this value is never actually visible to a
 * reviewer under normal operation. Set near the middle of the ~450-550px
 * real-world range this bug report measured (category picker + title +
 * comment + name + shot note + actions), rather than the old flat 160px
 * that assumed almost no content at all.
 */
const COMPOSER_HEIGHT_FALLBACK_PX = 500;

/**
 * Viewport-coordinate position for the composer, clamped so the WHOLE box —
 * not just its top-left corner — stays inside the visible viewport and clear
 * of the panel.
 *
 * The panel docks to whichever side keeps it off the launcher, so `panelSide`
 * decides WHICH horizontal bound its reservation moves: a right-docked panel
 * lowers the maximum left, a left-docked one raises the minimum instead.
 * Getting that backwards wouldn't merely fail to help — it would push the
 * composer straight under the panel it is supposed to avoid.
 */
function clampComposerPosition(
  anchor: Anchor,
  panelOpen: boolean,
  panelSide: PanelSide,
  composerHeight: number,
): { left: number; top: number } {
  // Mirrors `.r3wr-composer`'s own `width: min(336px, calc(100vw - 16px))`
  // — see that rule's comment in `overlay.css` for why the two must agree.
  const width = Math.min(336, window.innerWidth - 16);
  const vx = anchor.rect.x + anchor.offsetPct.x * anchor.rect.w - window.scrollX;
  const vy = anchor.rect.y + anchor.offsetPct.y * anchor.rect.h - window.scrollY;

  // How wide the panel's column is right now, or 0 when it isn't a column:
  // shut, or below the narrow breakpoint where it is a bottom sheet and stops
  // competing for horizontal space. `./panel-geometry` owns those numbers,
  // and `./launcher-position` clamps the launcher against the same ones.
  const reserved = panelOpen ? panelDockWidth(window.innerWidth) : 0;
  const reservedRight = panelSide === "right" ? reserved : 0;
  const reservedLeft = panelSide === "left" ? reserved : 0;

  // `Math.max(8, ...)`: if the panel and the composer's own minimum width
  // genuinely cannot both fit (an extremely narrow desktop window),
  // best-effort clamp to the 8px margin rather than let a bound go negative
  // and push the composer off the left edge — a little overlap with the
  // panel is a smaller failure than a composer nobody can reach.
  const maxLeft = Math.max(8, window.innerWidth - width - 8 - reservedRight);
  // The same posture pointed the other way, and the reason the bounds can
  // never invert: the left reservation is only honoured as far as `maxLeft`
  // allows, so a viewport too narrow to satisfy both gives up the clearance
  // rather than shoving the composer off the RIGHT edge. (Only one of the
  // two reservations is ever non-zero — the panel is on one side or the
  // other — so this never has to arbitrate between two real constraints.)
  const minLeft = Math.max(8, Math.min(8 + reservedLeft, maxLeft));
  const left = Math.max(minLeft, Math.min(vx + 16, maxLeft));

  const maxTop = Math.max(8, window.innerHeight - composerHeight - 8);
  const top = Math.max(8, Math.min(vy + 16, maxTop));

  return { left, top };
}

/** `clampComposerPosition`, using `el`'s real rendered height when mounted, else the first-paint fallback. */
function measureAndClamp(
  anchor: Anchor,
  panelOpen: boolean,
  panelSide: PanelSide,
  el: HTMLDivElement | null,
): { left: number; top: number } {
  const composerHeight = el?.getBoundingClientRect().height || COMPOSER_HEIGHT_FALLBACK_PX;
  return clampComposerPosition(anchor, panelOpen, panelSide, composerHeight);
}

export function Composer({
  anchor,
  config,
  identity,
  shotState,
  panelOpen,
  panelSide,
  onCancel,
  onSubmit,
  onUnlocked,
}: ComposerRenderProps) {
  const [category, setCategory] = useState(() => defaultCategoryId(config.categories, anchor.kind));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [name, setName] = useState(identity?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);

  // `autoFocus: false` — the body textarea below claims initial focus itself
  // (the effect right below), so the trap shouldn't fight it for the first tab.
  const ref = useFocusTrap<HTMLDivElement>(true, false);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const ids = useId();

  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  // Position near the pin in VIEWPORT coords (the composer is `fixed`),
  // clamped fully on-screen and clear of the panel — see
  // `clampComposerPosition` above. Seeded with a fallback height for the
  // very first paint; the layout effect below corrects it to the real
  // measured height before that paint happens.
  const [pos, setPos] = useState(() => measureAndClamp(anchor, panelOpen, panelSide, null));

  // Re-clamp to the composer's REAL rendered height, which varies with its
  // content (the name field, an error message, the inline password-recovery
  // form all change it) — before the browser paints, so a reviewer never
  // sees the fallback guess. Deliberately has no dependency array, so it
  // re-checks after every render rather than only on mount; the equality
  // guard is what keeps that from looping once `pos` already matches.
  useLayoutEffect(() => {
    setPos((prev) => {
      const next = measureAndClamp(anchor, panelOpen, panelSide, ref.current);
      return prev.left === next.left && prev.top === next.top ? prev : next;
    });
  });

  // A window resize can trigger the exact same clamp bug mid-session (the
  // panel's own `max-width: 94vw` shrinking it, or the viewport shrinking
  // under the composer's real height) — resize doesn't re-render on its
  // own, so this needs its own listener rather than relying on the layout
  // effect above.
  useEffect(() => {
    const onResize = () => setPos(measureAndClamp(anchor, panelOpen, panelSide, ref.current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [anchor, panelOpen, panelSide, ref]);

  const doSubmit = async (): Promise<boolean> => {
    setBusy(true);
    try {
      await onSubmit({ category, title, body, name });
      return true;
    } catch (err) {
      if (isLocked(err)) setNeedsPassword(true);
      else setError(err instanceof Error ? err.message : "Could not save this feedback.");
      setBusy(false);
      return false;
    }
  };

  const submit = async () => {
    setError(null);
    if (!body.trim()) {
      setError("Please add a comment.");
      return;
    }
    if (!identity && !name.trim()) {
      setError("Please add your name.");
      return;
    }
    await doSubmit();
  };

  /** The unlock just landed — retry the create so the draft isn't lost. */
  const afterUnlock = async () => {
    setError(null);
    onUnlocked();
    const ok = await doSubmit();
    if (ok) setNeedsPassword(false);
  };

  const selectedCategory = resolveCategory(config.categories, category);

  return (
    <div
      ref={ref}
      className="r3wr-composer"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${ids}-title`}
      {...TAG}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // See the matching comment in `./unlock-dialog`'s `UnlockDialog` —
          // `OverlayRoot`'s own Escape handling covers the integrated case;
          // this keeps the component independently correct on its own.
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="r3wr-composer-head" {...TAG}>
        <span className="r3wr-composer-title" id={`${ids}-title`} {...TAG}>
          {anchor.kind === "text" ? "Comment on this text" : "New feedback"}
        </span>
        <button
          type="button"
          className="r3wr-icon-btn"
          {...TAG}
          onClick={onCancel}
          aria-label="Discard this pin"
        >
          <XIcon size={16} />
        </button>
      </div>

      {/* The exact words being questioned — the reason a text pin exists. */}
      {anchor.selectedText && (
        <blockquote
          className="r3wr-quote r3wr-prose"
          {...TAG}
          style={{ "--r3wr-cat": categoryAccent(selectedCategory) } as CSSProperties}
        >
          {anchor.selectedText}
        </blockquote>
      )}

      <div className="r3wr-field" {...TAG}>
        <span className="r3wr-label" id={`${ids}-cat`} {...TAG}>
          Category
        </span>
        <div className="r3wr-cats" role="radiogroup" aria-labelledby={`${ids}-cat`} {...TAG}>
          {config.categories.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={category === c.id}
              className="r3wr-cat-btn"
              {...TAG}
              style={{ "--r3wr-cat": categoryAccent(c) } as CSSProperties}
              onClick={() => setCategory(c.id)}
            >
              <CategoryIcon categoryId={c.id} size={14} />
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="r3wr-field" {...TAG}>
        <label className="r3wr-label" htmlFor={`${ids}-title-input`} {...TAG}>
          Title (optional)
        </label>
        <input
          id={`${ids}-title-input`}
          className="r3wr-input"
          {...TAG}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Short summary"
        />
      </div>

      <div className="r3wr-field" {...TAG}>
        <label className="r3wr-label" htmlFor={`${ids}-body`} {...TAG}>
          Comment
        </label>
        <textarea
          id={`${ids}-body`}
          ref={bodyRef}
          className="r3wr-textarea r3wr-prose"
          {...TAG}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={anchor.kind === "text" ? "What's wrong with this wording?" : "What's wrong here?"}
        />
      </div>

      {!identity && (
        <div className="r3wr-field" {...TAG}>
          <label className="r3wr-label" htmlFor={`${ids}-name`} {...TAG}>
            Your name
          </label>
          <input
            id={`${ids}-name`}
            className="r3wr-input"
            {...TAG}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Who's reviewing?"
          />
        </div>
      )}

      {/* When `config.screenshots` is false — no `adapter.uploadScreenshot` at
          all, or the consumer explicitly opted out — no capture was ever
          attempted, so there is nothing honest to report; the note is
          omitted rather than printing a screenshot status for a feature
          that isn't in play. */}
      {config.screenshots && (
        <p className="r3wr-shot-note" {...TAG}>
          {shotState === "pending" ? (
            <>
              <span className="r3wr-spin" {...TAG} aria-hidden="true" />
              Capturing a screenshot…
            </>
          ) : shotState === "done" ? (
            "Screenshot attached."
          ) : shotState === "unavailable" ? (
            "Screenshot captured, but couldn't be saved — submitting without one."
          ) : (
            "No screenshot — submitting without one."
          )}
        </p>
      )}

      {needsPassword && (
        <PasswordForm
          config={config}
          label="The review session expired. Enter the password and this will be saved."
          idleLabel="Unlock & save"
          busyLabel="Saving…"
          onUnlocked={() => void afterUnlock()}
        />
      )}
      {error && (
        <p className="r3wr-error" role="alert" {...TAG}>
          <CircleAlertIcon size={13} />
          <span {...TAG}>{error}</span>
        </p>
      )}

      <div className="r3wr-actions" {...TAG}>
        <button
          type="button"
          className="r3wr-btn r3wr-btn-primary"
          {...TAG}
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : "Add feedback"}
        </button>
        <button type="button" className="r3wr-btn" {...TAG} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
