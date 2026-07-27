/**
 * Inline SVG icon set replacing the reference implementation's `lucide-react`
 * imports. This package deliberately takes no icon-library dependency, so
 * each glyph the ported UI needs is hand-drawn here as a tiny
 * `currentColor`-driven component instead.
 *
 * Every icon is `aria-hidden` — the accessible name lives on the interactive
 * control that hosts it (a button's `aria-label`, a badge's text), never on
 * the glyph itself.
 */

import type { SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
}

function base(size: number | undefined, props: SVGProps<SVGSVGElement>) {
  const s = size ?? 16;
  return {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
}

/** A bare "+" — the in-flight draft pin marker. */
export function PlusIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** A speech bubble with a "+" — the "drop a feedback pin" toggle. */
export function MessageSquarePlusIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6M9 10h6" />
    </svg>
  );
}

/** A key — the locked launcher. */
export function KeyRoundIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M15.5 7.5a4.5 4.5 0 1 1-4.5-4.5 4.5 4.5 0 0 1 4.5 4.5Z" />
      <path d="M11.5 11.5 2 21M6 21l-1.5-1.5M10 17l-1.5-1.5" />
    </svg>
  );
}

/** A close/dismiss "X". */
export function XIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** A checkmark — resolve. */
export function CheckIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** A counter-clockwise arrow — reopen. */
export function RotateCcwIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

/** A left chevron — the thread-detail back button. */
export function ChevronLeftIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/** A triangle with an exclamation mark — drift warning. */
export function TriangleAlertIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

/** A circled exclamation mark — inline field errors. */
export function CircleAlertIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  );
}

// ─────────────────────────── category glyphs ────────────────────────────

/** `design` — a painter's palette. */
export function PaletteIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 1.9-4.1 1.6 1.6 0 0 1 1.2-2.6H17a4 4 0 0 0 4-4c0-5-4-9-9-9Z" />
      <circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="11" cy="7" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** `copy` — a capital "A" in a text cursor, for wording. */
export function TypeIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M4 7V4h16v3M9 20h6M12 4v16" />
    </svg>
  );
}

/** `bug` — a bug glyph. */
export function BugIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <rect x="8" y="7" width="8" height="12" rx="4" />
      <path d="M8 12H3M21 12h-5M9 4l1.5 2M15 4l-1.5 2M8 9 5 7M16 9l3-2M8 16l-3 1M16 16l3 1M12 7v12" />
    </svg>
  );
}

/** `other` — a generic speech bubble. */
export function MessageCircleIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
  );
}

/** Fallback glyph for a category id outside the built-in four. */
export function TagIcon({ size, ...rest }: IconProps) {
  return (
    <svg {...base(size, rest)}>
      <path d="M12.6 2H4a2 2 0 0 0-2 2v8.6a2 2 0 0 0 .6 1.4l9 9a2 2 0 0 0 2.8 0l7.6-7.6a2 2 0 0 0 0-2.8l-9-9A2 2 0 0 0 12.6 2Z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Icons keyed to the four {@link DEFAULT_CATEGORIES} ids. */
const CATEGORY_ICONS: Record<string, (props: IconProps) => React.JSX.Element> = {
  design: PaletteIcon,
  copy: TypeIcon,
  bug: BugIcon,
  other: MessageCircleIcon,
};

/**
 * The category glyph for a thread's `category` id, so no call site has to
 * reach into a lookup table itself. Falls back to {@link TagIcon} for any id
 * outside the built-in four — a consumer-defined category always renders
 * something recognisable rather than nothing.
 */
export function CategoryIcon({
  categoryId,
  size = 13,
}: {
  categoryId: string;
  size?: number;
}) {
  const Icon = CATEGORY_ICONS[categoryId] ?? TagIcon;
  return <Icon size={size} />;
}
