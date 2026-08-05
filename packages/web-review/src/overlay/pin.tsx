/**
 * `Pin` — the clickable marker for one thread, positioned in document
 * coordinates inside the pin layer.
 *
 * Ported from a working single-app review tool's `feedback-overlay-inner.tsx`
 * `Pin` component. Two orthogonal axes, neither of them hue-only:
 *   CATEGORY → the glyph inside, plus its accent colour (`--r3wr-cat`)
 *   STATUS   → the FORM: filled = open, outlined = resolved
 *
 * A third axis rides on top of both: how well the anchor still binds to THIS
 * page — see `helpers.ts#anchorPlacement`. Two of its three states draw the
 * pin at its ORIGINAL captured position rather than a live (and possibly
 * wrong) one, and each says a different, separately-true thing about why:
 *   DRIFTED     → dashed amber ring; the resolver found a weak match, so the
 *                 anchor moved or changed under us.
 *   UNPLACEABLE → dotted, faded ring; the resolver found NOTHING here. The
 *                 copy must not blame the page for changing — we have no
 *                 evidence it did. (Dotted-and-faded vs dashed, not a second
 *                 hue: the two must be tellable apart in greyscale.)
 * Neither state hides the pin. A comment that silently disappears is worse
 * than one that says honestly where it was dropped.
 *
 * The marker also carries a hit-area child (`.r3wr-pin-hit`) that is the only
 * part of it which catches clicks — see the comment at its JSX below, and the
 * matching CSS rule in `overlay.css`.
 */

import type { CSSProperties } from "react";

import { OVERLAY_ATTR } from "../anchor";
import type { ResolveResult, ReviewCategoryDef, ReviewThreadView } from "../core/types";
import { CategoryIcon, PlusIcon } from "./icons";
import type { AnchorPlacement } from "./helpers";
import { anchorPlacement, categoryAccent, clampToDocument, resolveCategory } from "./helpers";

const TAG = { [OVERLAY_ATTR]: "" } as const;

/**
 * What each anchor state adds to the pin's accessible name and its tooltip —
 * the whole of what this package says about a marker that isn't sitting on
 * its element.
 *
 * Keyed by state rather than chosen inline so the wordings sit side by side,
 * where the difference between them is the point and a new state cannot be
 * added without writing one. "Drifted" may say the page changed: the
 * resolver matched something too weakly to trust, and edited content is what
 * produces that. "Not found" may not say it. An anchor that resolves to
 * nothing here is just as consistent with a page that never held it, so that
 * copy stops at what was actually observed — we looked, we did not find it,
 * and this is where the pin was dropped.
 */
const ANCHOR_NOTES: Record<AnchorPlacement["state"], { label: string; title: string }> = {
  anchored: { label: "", title: "" },
  drifted: {
    label: " (anchor drifted — shown where it was originally dropped)",
    title: "\nAnchor drifted — the page changed, this is the original position",
  },
  unplaceable: {
    label: " (anchor not found on this page — shown where it was dropped)",
    title: "\nAnchor not found on this page — this is where the pin was dropped",
  },
};

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
  const placement = anchorPlacement(resolved);
  const drifted = placement.state === "drifted";
  const unplaceable = placement.state === "unplaceable";

  const style: CSSProperties = (() => {
    if (placement.state === "anchored") {
      // Confident bind: the live rect plus the captured in-element offset.
      return clampToDocument(
        placement.rect.left + window.scrollX + thread.anchor.offsetPct.x * placement.rect.width,
        placement.rect.top + window.scrollY + thread.anchor.offsetPct.y * placement.rect.height,
      );
    }
    // Drifted or unplaceable: draw at the absolute captured rect, badged, so
    // the position is honest about being historical rather than quietly
    // wrong. The two states differ in what we SAY, never in whether the pin
    // renders — see the header.
    return clampToDocument(
      thread.anchor.rect.x + thread.anchor.offsetPct.x * thread.anchor.rect.w,
      thread.anchor.rect.y + thread.anchor.offsetPct.y * thread.anchor.rect.h,
    );
  })();

  const category = resolveCategory(categories, thread.category);
  const summary = thread.title ?? thread.anchor.selectedText ?? "Review note";
  const statusWord = thread.status === "resolved" ? "resolved" : "open";

  const anchorNote = ANCHOR_NOTES[placement.state];

  // The glyph carries category and the fill/hollow form carries status, so
  // the pin never depends on hue alone. `data-drifted` and `data-unplaceable`
  // are separate booleans (not one tri-valued attribute) so the long-standing
  // `data-drifted="true"|"false"` contract the E2E specs and CSS already read
  // keeps meaning exactly what it says — drift, and only drift.
  return (
    <button
      type="button"
      className="r3wr-pin"
      data-status={thread.status}
      data-drifted={drifted}
      data-unplaceable={unplaceable}
      data-selected={selected}
      {...TAG}
      style={{ ...style, "--r3wr-cat": categoryAccent(category) } as CSSProperties}
      onClick={onSelect}
      aria-label={
        `Review pin ${index}, ${category.label}, ${statusWord}: ${summary}` + anchorNote.label
      }
      title={`${category.label} · ${statusWord} · ${summary}` + anchorNote.title}
    >
      {/* The hit area, and the ONLY part of this marker that catches a
          click — `.r3wr-pin` itself is `pointer-events: none` and this box
          re-enables them over the teardrop's real outline (`overlay.css`
          carries the clip path and the derivation).

          Why a child rather than clipping the button: a `clip-path` on
          `.r3wr-pin` would trim the hit area correctly and take the drop
          shadow, the selected ring and the focus ring with it — clipping
          applies to everything the element paints, and two of those three
          are how a keyboard user and a screen-reader user find this control.
          A transparent child has nothing to lose to the clip, so the shape
          can be exact without costing anything visible.

          `aria-hidden` because it is geometry, not content: the button
          already carries the whole accessible name above, and an unnamed
          child inside it would only add a node for a screen reader to step
          over. Events still report the BUTTON as their target (this is a
          descendant, not a sibling overlay), so `onClick`, `:active` and the
          native `title` tooltip all behave exactly as they did. */}
      <span className="r3wr-pin-hit" aria-hidden="true" {...TAG} />
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
