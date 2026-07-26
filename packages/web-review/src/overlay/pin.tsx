/**
 * `Pin` — the clickable marker for one thread, positioned in document
 * coordinates inside the pin layer.
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * `Pin` component. Two orthogonal axes, neither of them hue-only:
 *   CATEGORY → the glyph inside, plus its accent colour (`--r3wr-cat`)
 *   STATUS   → the FORM: filled = open, outlined = resolved
 * A third state, "drifted" (see `helpers.ts#isDrifted`), adds a dashed amber
 * ring on top of both and draws the pin at its ORIGINAL captured position
 * rather than a live (and possibly wrong) one — an honest failure mode, not
 * a silently misplaced pin.
 */

import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import type { ResolveResult, ReviewCategoryDef, ReviewThreadView } from "../core/types";
import { CategoryIcon, PlusIcon } from "./icons";
import { categoryAccent, clampToDocument, isDrifted, resolveCategory } from "./helpers";

const TAG = { [OVERLAY_ATTR]: "" } as const;

export interface PinProps {
  thread: ReviewThreadView;
  /** 1-based ordinal, folded into the accessible label. */
  index: number;
  selected: boolean;
  onSelect: () => void;
  resolved: ResolveResult | undefined;
  categories: ReviewCategoryDef[];
}

export function Pin({ thread, index, selected, onSelect, resolved, categories }: PinProps) {
  const drifted = isDrifted(resolved);

  const style: CSSProperties = (() => {
    if (resolved?.el && resolved.rect && !drifted) {
      // Confident bind: the live rect plus the captured in-element offset.
      return clampToDocument(
        resolved.rect.left + window.scrollX + thread.anchor.offsetPct.x * resolved.rect.width,
        resolved.rect.top + window.scrollY + thread.anchor.offsetPct.y * resolved.rect.height,
      );
    }
    // Drifted: draw at the absolute captured rect, badged, so the position is
    // honest about being historical rather than quietly wrong.
    return clampToDocument(
      thread.anchor.rect.x + thread.anchor.offsetPct.x * thread.anchor.rect.w,
      thread.anchor.rect.y + thread.anchor.offsetPct.y * thread.anchor.rect.h,
    );
  })();

  const category = resolveCategory(categories, thread.category);
  const summary = thread.title ?? thread.anchor.selectedText ?? "Review note";
  const statusWord = thread.status === "resolved" ? "resolved" : "open";

  // The glyph carries category and the fill/hollow form carries status, so
  // the pin never depends on hue alone.
  return (
    <button
      type="button"
      className="r3wr-pin"
      data-status={thread.status}
      data-drifted={drifted}
      data-selected={selected}
      {...TAG}
      style={{ ...style, "--r3wr-cat": categoryAccent(category) } as CSSProperties}
      onClick={onSelect}
      aria-label={
        `Review pin ${index}, ${category.label}, ${statusWord}: ${summary}` +
        (drifted ? " (anchor drifted — shown where it was originally dropped)" : "")
      }
      title={
        `${category.label} · ${statusWord} · ${summary}` +
        (drifted ? "\nAnchor drifted — the page changed, this is the original position" : "")
      }
    >
      <CategoryIcon categoryId={thread.category} size={14} />
    </button>
  );
}

/** The in-flight draft marker shown while a new thread's composer is open. */
export function DraftPin({
  x,
  y,
}: {
  /** Document-coordinate position — the captured anchor's rect + offset. */
  x: number;
  y: number;
}) {
  return (
    <div className="r3wr-pin-draft" {...TAG} aria-hidden="true" style={{ left: x, top: y }}>
      <PlusIcon size={15} strokeWidth={3} />
    </div>
  );
}
