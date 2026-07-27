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

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import { isLocked } from "../core/adapter";
import type { AnchorKind, ReviewCategoryDef } from "../core/types";
import { useFocusTrap } from "../client/use-focus-trap";
import type { ComposerRenderProps } from "./overlay-root";
import { CategoryIcon, CircleAlertIcon, XIcon } from "./icons";
import { categoryAccent, resolveCategory } from "./helpers";
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

export function Composer({
  anchor,
  config,
  identity,
  shotState,
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

  // Position near the pin in VIEWPORT coords (the composer is `fixed`), clamped
  // on-screen. The width MUST mirror the stylesheet's `width: min(336px, calc(100vw
  // - 16px))` — clamping against a stale constant is how you get a composer that
  // hangs off the right edge and gives the page a horizontal scrollbar on a narrow
  // viewport.
  const COMPOSER_W = Math.min(336, window.innerWidth - 16);
  const vx = anchor.rect.x + anchor.offsetPct.x * anchor.rect.w - window.scrollX;
  const vy = anchor.rect.y + anchor.offsetPct.y * anchor.rect.h - window.scrollY;
  const left = Math.max(8, Math.min(vx + 16, window.innerWidth - COMPOSER_W - 8));
  const top = Math.max(8, Math.min(vy + 16, window.innerHeight - 160));

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
      style={{ left, top }}
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
