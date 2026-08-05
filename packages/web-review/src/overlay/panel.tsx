"use client";

/**
 * `Panel` — the side panel: the thread list for the current page (filter,
 * the pin/highlight visibility switches, close) or, once a thread is
 * selected, `./thread-detail`'s `ThreadDetail`. Plugs into `OverlayRoot` via
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
 *
 * Two things this surface owns that the reference's didn't, both consequences
 * of the launcher no longer arming pin-drop mode:
 *
 *  - **The "New comment" control.** With the launcher reduced to "open the
 *    panel", the explicit "add a comment" action has to live somewhere a
 *    reviewer can find it without already knowing the `c` shortcut, and this
 *    is the only surface that qualifies. It renders in the LIST view only:
 *    the detail view is a reading surface with its own primary affordance
 *    (back), and a second primary button there would compete with it for the
 *    one slot a primary action gets.
 *  - **The shortcuts footer.** The overlay's keyboard paths are now genuinely
 *    undiscoverable otherwise — the launcher's label used to advertise `c`
 *    and no longer does, the arrow-key launcher move (WCAG 2.5.7's non-drag
 *    alternative to dragging the button) never had a visible home at all, and
 *    a key you have to HOLD advertises itself least of all. It documents the
 *    OVERLAY, so it renders in both views, and it is pinned outside
 *    `.r3wr-panel-body` so a long thread list can never scroll it out of
 *    reach. Every entry in it is checked against the code that implements
 *    it — see the comments at each `<li>`.
 *
 * And one thing this surface says on the pins' behalf: when several pins on
 * the page could not be placed, the list view carries a single summary line
 * instead of leaving a wall of identical badges out on the page to be read
 * one at a time. What it is allowed to claim is narrow — see its comment.
 */

import { useId } from "react";
import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import { useFocusTrap } from "../client/use-focus-trap";
import type { PanelRenderProps } from "./overlay-root";
import { CategoryIcon, CheckIcon, PlusIcon, XIcon } from "./icons";
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
  panelSide,
  showHighlights,
  onToggleHighlights,
  showPins,
  onToggleShowPins,
  unplaceableCount,
  pinDropMode,
  onTogglePinDrop,
  onClose,
  onSelect,
  onBack,
  onReply,
  onToggleStatus,
  onUnlocked,
}: PanelRenderProps) {
  // `autoFocus: false` on purpose, and still the right call now that nothing
  // opens this panel implicitly. It is a reading surface the reviewer opened
  // deliberately from the launcher, and it sits ALONGSIDE a host page they
  // are still looking at rather than over one they've left — `useFocusTrap`
  // is a soft trap for exactly that reason. Pulling focus in on open would
  // move a keyboard user's place on the page (and jump a screen reader's
  // cursor) for a surface they may only want to glance at. Tab still cycles
  // once focus is inside, Escape closes it, and closing hands focus back to
  // wherever it came from (see `useFocusTrap`'s own restore-on-deactivate).
  const ref = useFocusTrap<HTMLElement>(true, false);
  const ids = useId();

  return (
    <aside
      ref={ref}
      className="r3wr-panel"
      // Which edge this panel docks to, written here rather than only onto
      // `OverlayRoot`'s chrome wrapper (`data-panel-side`) so the component
      // stays self-describing when a consumer renders it through their own
      // `renderPanel` outside that wrapper.
      data-side={panelSide}
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
        <button
          type="button"
          className="r3wr-icon-btn"
          {...TAG}
          onClick={onClose}
          aria-label="Close the review panel"
        >
          <XIcon size={17} />
        </button>

        {/* The two layer switches, on their own row (see `.r3wr-visibility` in
            `overlay.css` for why they cannot share the title's line).

            A named group rather than two loose checkboxes: "Pins" and
            "Highlights" are only meaningful as a pair, and a checkbox called
            "Pins" reached in isolation — which is exactly how a screen-reader
            user meets it — says nothing about what it does to them.

            Pins first because it is the switch that matters most: a highlight
            can only ever obscure something, while a pin is a real button
            laid over the page that takes clicks meant for whatever is under
            it. This is the reviewer's way out of that, and the hold key in
            the shortcuts strip below is the momentary version of the same
            escape. */}
        <div
          className="r3wr-visibility"
          role="group"
          aria-label="Show on the page"
          {...TAG}
        >
          <label className="r3wr-visibility-toggle" {...TAG}>
            <input type="checkbox" {...TAG} checked={showPins} onChange={onToggleShowPins} />
            <span {...TAG}>Pins</span>
          </label>
          <label className="r3wr-visibility-toggle" {...TAG}>
            <input
              type="checkbox"
              {...TAG}
              checked={showHighlights}
              onChange={onToggleHighlights}
            />
            <span {...TAG}>Highlights</span>
          </label>
        </div>
      </div>

      {/* The panel's primary action, and the only one on this surface. A
          sibling of the body rather than its first child, so it stays put
          while the thread list scrolls under it — the "add a comment" action
          being scrolled away by the feedback already on the page would be
          exactly backwards. */}
      {!selected && (
        <button
          type="button"
          className="r3wr-new-comment"
          {...TAG}
          // The state lives here, not in the colour: `aria-pressed` is what
          // tells assistive tech that picking is armed, and the visible
          // label changes word as well as treatment.
          aria-pressed={pinDropMode}
          // The visible label is deliberately terse ("Cancel"); the
          // accessible name has to say what pressing the button actually
          // does in either state.
          aria-label={
            pinDropMode
              ? "Cancel adding a comment"
              : "New comment. Select the words or the element to comment on"
          }
          onClick={onTogglePinDrop}
        >
          {pinDropMode ? (
            // No shortcut hint while armed: the on-page capture hint is
            // already telling the reviewer what to click and that Escape
            // cancels, and a second, quieter copy of that here would only
            // compete with it.
            "Cancel"
          ) : (
            <>
              <PlusIcon size={14} />
              <span {...TAG}>New comment</span>
              <kbd {...TAG}>C</kbd>
            </>
          )}
        </button>
      )}

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

            {/* One line for the whole page in place of N identical badges.
                Absent entirely at zero — a "0 pins couldn't be placed" that
                sits there permanently is a warning about nothing.

                The copy asserts only what was observed, and stops. It does
                NOT say the page changed, because nothing here supports that:
                an anchor that resolves to nothing is just as consistent with
                a page that never held it (a reviewer on a different
                environment, a different data set, a route that renders the
                same key differently) as with one that was edited. Same
                discipline as `./thread-detail`'s own not-found note and
                `./pin`'s `ANCHOR_NOTES` — we looked, we did not find it, and
                here is where the pin was dropped.

                And it counts `unplaceable` only, never `drifted`. Those are
                two different findings with two different things worth saying,
                and one number covering both would be the conflation
                `anchorPlacement` was split apart to end. */}
            {unplaceableCount > 0 && (
              <p className="r3wr-unplaceable-summary" {...TAG}>
                {unplaceableCount === 1
                  ? "1 pin couldn't be placed on this page. It is shown where it was dropped."
                  : `${unplaceableCount} pins couldn't be placed on this page. They are shown where they were dropped.`}
              </p>
            )}

            {threads.length === 0 ? (
              <p className="r3wr-muted" {...TAG}>
                No {filter === "all" ? "" : filter} feedback on this page yet. Use{" "}
                <strong>New comment</strong> above — or press <strong>C</strong> — then select the
                words or the element you want to comment on.
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

      {/* Pinned outside `.r3wr-panel-body`, so the body keeps its own
          `overflow-y: auto` and this strip never scrolls away. A real list
          with a name rather than a row of spans: it is three discrete facts,
          and a screen-reader user should be able to hear how many there are
          and step through them.

          Every entry below is a claim about shipped behaviour. Documenting a
          shortcut the code does not implement would be worse than documenting
          none, so each one carries the code that backs it. */}
      <footer className="r3wr-shortcuts" {...TAG}>
        <ul aria-label="Keyboard shortcuts" {...TAG}>
          {/* `OverlayRoot`'s keydown handler: `c` with no modifier, ignored
              while a text field has focus or a draft composer is open. */}
          <li {...TAG}>
            <kbd {...TAG}>C</kbd>
            <span {...TAG}>New pin</span>
          </li>
          {/* Same handler: Escape unwinds ONE layer per press — unlock dialog,
              then pin-drop mode, then the draft composer, then the panel. */}
          <li {...TAG}>
            <kbd {...TAG}>Esc</kbd>
            <span {...TAG}>Close / cancel</span>
          </li>
          {/* `OverlayRoot`'s pass-through effect: `PASS_THROUGH_KEY`, held.
              Verified against that handler rather than assumed — it is a HOLD
              (keydown arms, keyup and every stranding event release it), it
              is ignored while a text field has focus, and it frees the whole
              pin layer rather than one pin, which is why the label says "the
              pins" and not "a pin". A letter and not Alt: the click that
              follows has to be an ordinary click, and every modifier changes
              what clicking a link does. */}
          <li {...TAG}>
            <kbd {...TAG}>H</kbd>
            <span {...TAG}>Hold to click through the pins</span>
          </li>
          {/* `Launcher`'s own `onKeyDown` + `edgeForArrowKey` — the WCAG 2.5.7
              non-drag alternative to dragging the button to an edge. These
              are NOT global: the launcher has to have focus, and the label
              has to say so rather than implying otherwise. */}
          <li {...TAG}>
            <span className="r3wr-keys" {...TAG}>
              <kbd {...TAG}>←</kbd>
              <kbd {...TAG}>↑</kbd>
              <kbd {...TAG}>↓</kbd>
              <kbd {...TAG}>→</kbd>
            </span>
            <span {...TAG}>Move the Review button, while it has focus</span>
          </li>
        </ul>
        {/* The permanent counterpart to the hold key, named here because the
            two answer the same question and a reviewer who has just found one
            should be told about the other. Outside the list, not a fourth
            entry in it: the list is called "Keyboard shortcuts" and every
            item in it is a key, whereas this is a pair of checkboxes. Filing
            a checkbox under keyboard shortcuts would make the list's own name
            the first inaccurate claim in the strip. */}
        <p className="r3wr-shortcuts-note" {...TAG}>
          To hide the pins for good, use <strong {...TAG}>Pins</strong> at the top of this panel.
        </p>
      </footer>
    </aside>
  );
}
