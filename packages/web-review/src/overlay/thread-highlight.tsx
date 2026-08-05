/**
 * `ThreadHighlight` — the captured highlight boxes, redrawn over a thread's
 * anchored element (or, when the anchor no longer binds here, its historical
 * position).
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * `ThreadHighlight` component. Renders nothing for a legacy `point` pin (no
 * rects). Text highlights read as a highlighter swipe under the words;
 * element highlights read as an outlined box so they never hide the design
 * under review.
 *
 * Carries the same two `data-*` flags as `./pin` — `data-drifted` for a weak
 * match, `data-unplaceable` for no match at all — so a highlight and its pin
 * never tell a reviewer two different stories about the same anchor, and so
 * `overlay.css` can give each its own FORM (dashed vs dotted) rather than
 * distinguishing them by hue. See `helpers.ts#anchorPlacement`.
 */

import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import type { ResolveResult, ReviewCategoryDef, ReviewThreadView } from "../core/types";
import type { DocRect } from "./helpers";
import { anchorPlacement, categoryAccent, resolveCategory } from "./helpers";

const TAG = { [OVERLAY_ATTR]: "" } as const;

export interface ThreadHighlightProps {
  thread: ReviewThreadView;
  selected: boolean;
  resolved: ResolveResult | undefined;
  categories: ReviewCategoryDef[];
}

export function ThreadHighlight({ thread, selected, resolved, categories }: ThreadHighlightProps) {
  const rectsPct = thread.anchor.highlightRectsPct;
  if (!rectsPct || rectsPct.length === 0) return null;

  const placement = anchorPlacement(resolved);

  // Base in DOCUMENT coords: the live rect when the bind is confident, else
  // the absolute captured rect so a drifted or unplaceable highlight still
  // shows somewhere rather than vanishing.
  const base: DocRect =
    placement.state === "anchored"
      ? {
          left: placement.rect.left + window.scrollX,
          top: placement.rect.top + window.scrollY,
          width: placement.rect.width,
          height: placement.rect.height,
        }
      : {
          left: thread.anchor.rect.x,
          top: thread.anchor.rect.y,
          width: thread.anchor.rect.w,
          height: thread.anchor.rect.h,
        };

  // A real text selection yields one client rect PER LINE BOX, so the wash
  // lands on narrow strips of type and stays legible. But `captureAnchor`
  // falls back to a single full-element box when a selection reports no
  // usable geometry — and washing an entire heading in colour hides the very
  // design under review. So the degenerate case is drawn as an outline
  // instead: the highlighter is reserved for rects that are actually
  // text-shaped.
  const first = rectsPct[0];
  const isFullBox = rectsPct.length === 1 && !!first && first.w >= 0.999 && first.h >= 0.999;
  const kind = thread.anchor.kind === "text" && !isFullBox ? "text" : "element";

  const category = resolveCategory(categories, thread.category);
  const accent = categoryAccent(category);

  return (
    <>
      {rectsPct.map((p, i) => (
        <div
          key={`${thread.id}-${i}`}
          className="r3wr-highlight"
          data-kind={kind}
          data-status={thread.status}
          data-selected={selected}
          data-drifted={placement.state === "drifted"}
          data-unplaceable={placement.state === "unplaceable"}
          {...TAG}
          style={
            {
              "--r3wr-cat": accent,
              left: base.left + p.x * base.width,
              top: base.top + p.y * base.height,
              width: p.w * base.width,
              height: p.h * base.height,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}
