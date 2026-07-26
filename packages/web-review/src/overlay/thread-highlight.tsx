/**
 * `ThreadHighlight` — the captured highlight boxes, redrawn over a thread's
 * anchored element (or, when drifted, its historical position).
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * `ThreadHighlight` component. Renders nothing for a legacy `point` pin (no
 * rects). Text highlights read as a highlighter swipe under the words;
 * element highlights read as an outlined box so they never hide the design
 * under review.
 */

import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import type { ResolveResult, ReviewCategoryDef, ReviewThreadView } from "../core/types";
import type { DocRect } from "./helpers";
import { categoryAccent, isDrifted, resolveCategory } from "./helpers";

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

  const drifted = isDrifted(resolved);

  // Base in DOCUMENT coords: the live rect when the bind is confident, else
  // the absolute captured rect so a drifted highlight still shows somewhere.
  const base: DocRect =
    resolved?.rect && !drifted
      ? {
          left: resolved.rect.left + window.scrollX,
          top: resolved.rect.top + window.scrollY,
          width: resolved.rect.width,
          height: resolved.rect.height,
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
          data-drifted={drifted}
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
