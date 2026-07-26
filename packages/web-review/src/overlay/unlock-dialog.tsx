"use client";

/**
 * `UnlockDialog` + `PasswordForm` — the shared password field.
 *
 * `UnlockDialog` is the locked launcher's dialog: it plugs into `OverlayRoot`
 * via `renderUnlockDialog` (see `./overlay-root`'s `UnlockRenderProps`).
 * `PasswordForm` is reused inline by `Composer` and `ThreadDetail` when a
 * write comes back 401 — the typed draft/reply/status change stays on
 * screen and is retried the moment the unlock resolves, so nothing anyone
 * wrote is lost.
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * `UnlockDialog` (~996-1048) and `PasswordForm` (~1049-1125). The only
 * substantive change: `unlock()` there was a fixed import hitting one
 * hardcoded route; here it's `config.adapter.unlock` — present whenever this
 * component is reachable (`OverlayRoot` only renders `renderUnlockDialog`
 * when `gate === "locked"`, and the inline 401-recovery call sites in
 * `Composer`/`ThreadDetail` are only reachable once `isLocked` was already
 * true on a real write, both of which imply an adapter that implements
 * `unlock`). The `if (!unlock)` guard below is defensive, not expected to
 * ever actually render its error in practice.
 */

import { useId, useState } from "react";

import { OVERLAY_ATTR } from "../anchor";
import { unlockErrorMessage } from "../core/adapter";
import type { ResolvedReviewConfig } from "../core/config";
import { useFocusTrap } from "../client/use-focus-trap";
import type { UnlockRenderProps } from "./overlay-root";
import { CircleAlertIcon, XIcon } from "./icons";

const TAG = { [OVERLAY_ATTR]: "" } as const;

export function UnlockDialog({ config, onClose, onUnlocked }: UnlockRenderProps) {
  const ref = useFocusTrap<HTMLDivElement>(true);
  return (
    <div
      ref={ref}
      className="r3wr-composer"
      role="dialog"
      aria-modal="true"
      aria-label="Unlock review"
      {...TAG}
      style={{
        right: "calc(18px + env(safe-area-inset-right))",
        bottom: "calc(18px + env(safe-area-inset-bottom) + 56px)",
        left: "auto",
        top: "auto",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Stop React's own synthetic propagation only — `OverlayRoot`'s
          // native `window` keydown listener (unaffected by this) already
          // closes `unlockOpen` on Escape too; this handler exists so the
          // dialog is independently correct when rendered on its own, e.g.
          // in this file's tests.
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="r3wr-composer-head" {...TAG}>
        <span className="r3wr-composer-title" {...TAG}>
          Review is locked
        </span>
        <button
          type="button"
          className="r3wr-icon-btn"
          {...TAG}
          onClick={onClose}
          aria-label="Close"
        >
          <XIcon size={16} />
        </button>
      </div>
      <PasswordForm
        config={config}
        label="Enter the review password to see and leave feedback."
        idleLabel="Unlock"
        busyLabel="Unlocking…"
        onUnlocked={onUnlocked}
      />
    </div>
  );
}

export interface PasswordFormProps {
  config: ResolvedReviewConfig;
  label: string;
  idleLabel: string;
  busyLabel: string;
  onUnlocked: () => void;
}

/**
 * The shared password field. Used by the launcher's `UnlockDialog` and
 * inline by `Composer`/`ThreadDetail` when a write comes back 401.
 */
export function PasswordForm({ config, label, idleLabel, busyLabel, onUnlocked }: PasswordFormProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const submit = async () => {
    const trimmed = password.trim();
    if (!trimmed) return;
    // Called through the property access itself, never hoisted to a local —
    // hoisting a method reference off an interface-typed object trips
    // `@typescript-eslint/unbound-method` (the method's implicit `this`
    // parameter), and see `beginScreenshot` in `../overlay/overlay-root.tsx`
    // for the same concern with `config.adapter.uploadScreenshot`.
    if (!config.adapter.unlock) {
      setError("Review is not enabled on this deployment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await config.adapter.unlock(trimmed);
      setPassword("");
      onUnlocked();
    } catch (err) {
      setError(unlockErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="r3wr-field" {...TAG}>
      <label className="r3wr-label" htmlFor={inputId} {...TAG}>
        {label}
      </label>
      <input
        id={inputId}
        className="r3wr-input"
        {...TAG}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Review password"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-err` : undefined}
        autoFocus
      />
      {error && (
        <p className="r3wr-error" id={`${inputId}-err`} role="alert" {...TAG}>
          <CircleAlertIcon size={13} />
          <span {...TAG}>{error}</span>
        </p>
      )}
      <div className="r3wr-actions" {...TAG}>
        <button
          type="button"
          className="r3wr-btn r3wr-btn-primary"
          {...TAG}
          disabled={busy || !password.trim()}
          onClick={() => void submit()}
        >
          {busy ? busyLabel : idleLabel}
        </button>
      </div>
    </div>
  );
}
