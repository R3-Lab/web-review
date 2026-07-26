"use client";

/**
 * `ThreadDetail` — one thread's comment history (oldest first), a reply box,
 * resolve/reopen, and a drift note. Rendered by `./panel`'s `Panel` when a
 * thread is selected.
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * `ThreadDetail` (~1583-1815). `confidence` there (a bare number) is
 * `resolved: ResolveResult | undefined` here, run through `isDrifted` from
 * `./helpers` — the same helper `Pin`/`ThreadHighlight` use, so "drifted"
 * means exactly the same thing everywhere in this package.
 *
 * One deliberate addition beyond the reference: the reference's resolve/
 * reopen button was fire-and-forget (no error handling at all). Here it gets
 * the SAME inline-unlock recovery as the reply box — a 401 on `onToggleStatus`
 * shows the password field and retries the status flip once unlocked, rather
 * than silently failing.
 */

import { useId, useState } from "react";
import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import { isLocked } from "../core/adapter";
import type { ResolvedReviewConfig } from "../core/config";
import type { ResolveResult, ReviewerIdentity, ReviewThreadView } from "../core/types";
import {
  CategoryIcon,
  CheckIcon,
  ChevronLeftIcon,
  CircleAlertIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "./icons";
import { categoryAccent, formatTime, isDrifted, resolveCategory } from "./helpers";
import { PasswordForm } from "./unlock-dialog";

const TAG = { [OVERLAY_ATTR]: "" } as const;

export interface ThreadDetailProps {
  config: ResolvedReviewConfig;
  thread: ReviewThreadView;
  /** The thread's live anchor resolution, for the drift note. */
  resolved: ResolveResult | undefined;
  identity: ReviewerIdentity | null;
  onBack: () => void;
  onReply: (threadId: string, body: string, name: string) => Promise<void>;
  onToggleStatus: (thread: ReviewThreadView) => Promise<void>;
  onUnlocked: () => void;
}

/** Which write is pending an inline unlock retry, so `afterUnlock` knows what to redo. */
type PendingAction = "reply" | "status";

export function ThreadDetail({
  config,
  thread,
  resolved,
  identity,
  onBack,
  onReply,
  onToggleStatus,
  onUnlocked,
}: ThreadDetailProps) {
  const [reply, setReply] = useState("");
  const [name, setName] = useState(identity?.name ?? "");
  const [replyBusy, setReplyBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState<PendingAction | null>(null);
  const ids = useId();

  const drifted = isDrifted(resolved);
  const category = resolveCategory(config.categories, thread.category);
  const catStyle = { "--r3wr-cat": categoryAccent(category) } as CSSProperties;

  const doReply = async (): Promise<boolean> => {
    setReplyBusy(true);
    try {
      await onReply(thread.id, reply, name);
      setReply("");
      return true;
    } catch (err) {
      if (isLocked(err)) setNeedsPassword("reply");
      else setError(err instanceof Error ? err.message : "Could not post the reply.");
      return false;
    } finally {
      setReplyBusy(false);
    }
  };

  const submitReply = async () => {
    setError(null);
    if (!reply.trim()) return;
    if (!identity && !name.trim()) {
      setError("Please add your name.");
      return;
    }
    await doReply();
  };

  const doToggleStatus = async (): Promise<boolean> => {
    setStatusBusy(true);
    try {
      await onToggleStatus(thread);
      return true;
    } catch (err) {
      if (isLocked(err)) setNeedsPassword("status");
      else setError(err instanceof Error ? err.message : "Could not update this thread.");
      return false;
    } finally {
      setStatusBusy(false);
    }
  };

  /** The unlock just landed — retry whichever write triggered it. */
  const afterUnlock = async () => {
    setError(null);
    onUnlocked();
    const pending = needsPassword;
    const ok = pending === "status" ? await doToggleStatus() : await doReply();
    if (ok) setNeedsPassword(null);
  };

  return (
    <>
      <button type="button" className="r3wr-back" {...TAG} onClick={onBack}>
        <ChevronLeftIcon size={16} />
        All feedback
      </button>

      <div className="r3wr-thread-meta" {...TAG} style={catStyle}>
        <span className="r3wr-cat" {...TAG}>
          <CategoryIcon categoryId={thread.category} size={12} />
          {category.label}
        </span>
        <span className="r3wr-status" data-status={thread.status} {...TAG}>
          {thread.status === "resolved" ? <CheckIcon size={12} /> : null}
          {thread.status === "resolved" ? "Resolved" : "Open"}
        </span>
        {drifted && (
          <span className="r3wr-drift-chip" {...TAG}>
            <TriangleAlertIcon size={12} />
            Drifted
          </span>
        )}
        {/* `locale` is free-form and consumer-populated (see `ReviewThreadView.locale`
            in `core/types.ts`) — omitted entirely when the consumer never set one,
            rather than guessing at a locale scheme this package doesn't know. */}
        {thread.locale && (
          <span className="r3wr-locale-tag" {...TAG}>
            {thread.locale}
          </span>
        )}
      </div>
      {thread.title && (
        <p className="r3wr-thread-title" {...TAG}>
          {thread.title}
        </p>
      )}

      {thread.anchor.selectedText && (
        <blockquote className="r3wr-quote r3wr-prose" {...TAG} style={catStyle}>
          {thread.anchor.selectedText}
        </blockquote>
      )}

      {/* Never let a reviewer believe a pin is still pointing at what it was
          dropped on when the resolver says otherwise. */}
      {drifted && (
        <p className="r3wr-drift-note" {...TAG}>
          <TriangleAlertIcon size={14} />
          <span {...TAG}>
            The page changed since this was pinned, so the marker is shown where it was
            originally dropped rather than on a guessed element.
            {thread.anchor.textHint ? ` It was on: "${thread.anchor.textHint}".` : ""}
          </span>
        </p>
      )}

      {thread.screenshotUrl ? (
        <img
          className="r3wr-shot"
          {...TAG}
          src={thread.screenshotUrl}
          alt={`Screenshot taken when this feedback was left${thread.title ? `: ${thread.title}` : ""}`}
        />
      ) : (
        <p className="r3wr-shot-note" {...TAG}>
          No screenshot was captured for this pin.
        </p>
      )}

      <div {...TAG}>
        {thread.comments.map((c) => (
          <div className="r3wr-comment" key={c.id} {...TAG}>
            <div className="r3wr-comment-head" {...TAG}>
              <span className="r3wr-comment-author" {...TAG}>
                {c.authorName}
              </span>
              <span className="r3wr-muted" {...TAG}>
                {formatTime(c.createdAt)}
              </span>
            </div>
            <div className="r3wr-comment-body r3wr-prose" {...TAG}>
              {c.body}
            </div>
          </div>
        ))}
      </div>

      {!identity && (
        <div className="r3wr-field" {...TAG} style={{ marginTop: 10 }}>
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

      <div className="r3wr-field" {...TAG} style={{ marginTop: 10 }}>
        <label className="r3wr-label" htmlFor={`${ids}-reply`} {...TAG}>
          Reply
        </label>
        <textarea
          id={`${ids}-reply`}
          className="r3wr-textarea r3wr-prose"
          {...TAG}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Add to this thread…"
        />
      </div>

      {needsPassword && (
        <PasswordForm
          config={config}
          label={
            needsPassword === "status"
              ? "The review session expired. Enter the password and this status change will be saved."
              : "The review session expired. Enter the password and this reply will be posted."
          }
          idleLabel={needsPassword === "status" ? "Unlock & save" : "Unlock & reply"}
          busyLabel={needsPassword === "status" ? "Saving…" : "Posting…"}
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
          disabled={replyBusy || !reply.trim()}
          onClick={() => void submitReply()}
        >
          {replyBusy ? "Posting…" : "Reply"}
        </button>
        <button
          type="button"
          className="r3wr-btn"
          {...TAG}
          disabled={statusBusy}
          onClick={() => void doToggleStatus()}
        >
          {thread.status === "open" ? (
            <>
              <CheckIcon size={15} /> Resolve
            </>
          ) : (
            <>
              <RotateCcwIcon size={15} /> Reopen
            </>
          )}
        </button>
      </div>
    </>
  );
}
