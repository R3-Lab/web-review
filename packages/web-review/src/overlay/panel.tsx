"use client";

/**
 * `Panel` — the side panel: the thread list for the current page (filter,
 * highlight-visibility toggle, close) or, once a thread is selected,
 * `./thread-detail`'s `ThreadDetail`. Plugs into `OverlayRoot` via
 * `renderPanel` (see `./overlay-root`'s `PanelRenderProps`).
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * `Panel` (~1391-1582). One dropped feature, deliberately: the reference
 * showed a locale badge next to the urlKey, derived by guessing at a fixed
 * `/tr` path prefix — a heuristic specific to that one app's two-locale
 * setup. This package's `urlKey` carries no locale information (locale is a
 * free-form, consumer-populated field on each THREAD, not the page key — see
 * `ReviewThreadView.locale` in `core/types.ts`), so there's nothing generic
 * to show here; `ThreadDetail` still surfaces a thread's own `locale` when
 * one is set.
 */

import { useId } from "react";
import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import { useFocusTrap } from "../client/use-focus-trap";
import type { PanelRenderProps } from "./overlay-root";
import { CategoryIcon, CheckIcon, XIcon } from "./icons";
import { categoryAccent, formatTime, resolveCategory } from "./helpers";
import { ThreadDetail } from "./thread-detail";

const TAG = { [OVERLAY_ATTR]: "" } as const;

const FILTERS = ["open", "resolved", "all"] as const;

export function Panel({
  config,
  urlKey,
  threads,
  filter,
  onFilterChange,
  selected,
  selectedResolved,
  identity,
  showHighlights,
  onToggleHighlights,
  onClose,
  onSelect,
  onBack,
  onReply,
  onToggleStatus,
  onUnlocked,
}: PanelRenderProps) {
  // `autoFocus: false` on purpose. The panel opens as a side effect of
  // entering pin-drop mode, and yanking focus off the page at that moment
  // would fight the gesture the reviewer is mid-way through. Tab still
  // cycles once focus is inside, Escape closes it, and closing hands focus
  // back to the toggle (see `useFocusTrap`'s own restore-on-deactivate).
  const ref = useFocusTrap<HTMLElement>(true, false);
  const ids = useId();

  return (
    <aside
      ref={ref}
      className="r3wr-panel"
      role="dialog"
      aria-labelledby={`${ids}-title`}
      {...TAG}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // See the matching comment in `./unlock-dialog`'s `UnlockDialog` —
          // `OverlayRoot`'s own Escape handling covers the integrated case;
          // this keeps the component independently correct on its own.
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="r3wr-panel-header" {...TAG}>
        <h2 className="r3wr-panel-title" id={`${ids}-title`} {...TAG}>
          {selected ? "Thread" : "Feedback on this page"}
        </h2>
        <label className="r3wr-highlight-toggle" {...TAG}>
          <input type="checkbox" {...TAG} checked={showHighlights} onChange={onToggleHighlights} />
          <span {...TAG}>Highlights</span>
        </label>
        <button
          type="button"
          className="r3wr-icon-btn"
          {...TAG}
          onClick={onClose}
          aria-label="Close the review panel"
        >
          <XIcon size={17} />
        </button>
      </div>

      <div className="r3wr-panel-body" {...TAG}>
        {selected ? (
          <ThreadDetail
            config={config}
            thread={selected}
            resolved={selectedResolved}
            identity={identity}
            onBack={onBack}
            onReply={onReply}
            onToggleStatus={onToggleStatus}
            onUnlocked={onUnlocked}
          />
        ) : (
          <>
            <span className="r3wr-panel-urlkey" {...TAG}>
              {urlKey}
            </span>

            <div className="r3wr-filter" role="group" aria-label="Filter threads" {...TAG}>
              {FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className="r3wr-chip"
                  aria-pressed={filter === f}
                  {...TAG}
                  onClick={() => onFilterChange(f)}
                >
                  {f[0]!.toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>

            {threads.length === 0 ? (
              <p className="r3wr-muted" {...TAG}>
                No {filter === "all" ? "" : filter} feedback on this page yet. Press{" "}
                <strong>C</strong>, then select the words or the element you want to comment on.
              </p>
            ) : (
              threads.map((t) => {
                const category = resolveCategory(config.categories, t.category);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className="r3wr-thread"
                    {...TAG}
                    style={{ "--r3wr-cat": categoryAccent(category) } as CSSProperties}
                    onClick={() => onSelect(t.id)}
                  >
                    <span className="r3wr-thread-meta" {...TAG}>
                      {/* Category: hue AND glyph AND word. */}
                      <span className="r3wr-cat" {...TAG}>
                        <CategoryIcon categoryId={t.category} size={12} />
                        {category.label}
                      </span>
                      {/* Status: word AND form (outlined open / filled resolved). */}
                      <span className="r3wr-status" data-status={t.status} {...TAG}>
                        {t.status === "resolved" ? <CheckIcon size={12} /> : null}
                        {t.status === "resolved" ? "Resolved" : "Open"}
                      </span>
                      <span className="r3wr-muted" {...TAG}>
                        {t.commentCount} {t.commentCount === 1 ? "comment" : "comments"}
                      </span>
                    </span>
                    {t.title && (
                      <span className="r3wr-thread-title" {...TAG}>
                        {t.title}
                      </span>
                    )}
                    {t.anchor.selectedText && (
                      <span className="r3wr-quote r3wr-prose" {...TAG}>
                        {t.anchor.selectedText}
                      </span>
                    )}
                    {/* The list projection returns `comments: []` and sizes a
                        thread with `commentCount` alone, so there is usually no
                        body to preview here — only a thread just created in
                        this session, or one hydrated by `onSelect`, carries
                        one. Show the preview when it exists and stay quiet
                        otherwise, rather than rendering a flat contradiction
                        like "2 comments" above "(no comment)". */}
                    {t.comments[0] && (
                      <span className="r3wr-thread-snippet r3wr-prose" {...TAG}>
                        {t.comments[0].body}
                      </span>
                    )}
                    <span className="r3wr-muted" {...TAG}>
                      {t.authorName} · {formatTime(t.createdAt)}
                    </span>
                  </button>
                );
              })
            )}
          </>
        )}
      </div>
    </aside>
  );
}
