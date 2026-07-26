"use client";

/**
 * A focus trap for the overlay's dialog surfaces (composer, thread panel,
 * unlock prompt). Ported from a working single-app review tool's
 * `components/feedback/use-focus-trap.ts`.
 *
 * It is a SOFT trap on purpose: the `keydown` listener lives on the
 * container, not the document, so Tab cycles while focus is inside but a
 * mouse click anywhere on the page still frees the reviewer. That is the
 * right shape for a side panel (a drawer read alongside the page) and is
 * still a complete trap for a modal composer, which takes focus on open and
 * is dismissed with Esc.
 *
 * On deactivate, focus returns to whatever had it before — but only if that
 * element is still in the document, so a closing panel can't throw focus
 * into a detached node.
 */

import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Returns a ref to attach to the dialog container. While `active`, focus
 * moves inside on mount and Tab wraps within it.
 *
 * `autoFocus: false` keeps the initial focus move out of the way for
 * surfaces that manage it themselves (e.g. a composer that focuses its own
 * textarea).
 */
export function useFocusTrap<T extends HTMLElement>(
  active: boolean,
  autoFocus = true,
) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;

    const previous = document.activeElement as HTMLElement | null;

    if (autoFocus && !node.contains(document.activeElement)) {
      (focusables(node)[0] ?? node).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables(node);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !node.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !node.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [active, autoFocus]);

  return ref;
}
