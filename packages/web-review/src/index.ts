"use client";

// Client entry point: browser review overlay (pin placement, threaded
// comments UI), the DOM anchoring engine, wire types, and the React
// adapter used to mount the overlay in a consuming app. `ReviewOverlay` is
// the mount gate a consumer's layout imports; it renders nothing until
// switched on, and its shell (pins, highlights, drift, keyboard handling,
// polling — WP4a) lazy-loads behind it. `Composer`, `Panel`, `ThreadDetail`,
// and `UnlockDialog` (WP4b) are wired in as `ReviewOverlay`'s defaults for
// `renderComposer` / `renderPanel` / `renderUnlockDialog` — see
// `./overlay/overlay-root` for the exact seam each one implements against —
// and are exported here too, individually, for a consumer who wants to
// override just one surface while reusing the others.

export * from "./core/types";
export * from "./core/adapter";
export * from "./core/config";
export * from "./anchor";
export * from "./client/identity";
export * from "./client/screenshot";
export * from "./client/http-adapter";
export * from "./client/use-focus-trap";
export * from "./client/use-location";
export * from "./overlay/review-overlay";
export type {
  ComposerRenderProps,
  OverlayRootProps,
  PanelRenderProps,
  ShotState,
  UnlockRenderProps,
} from "./overlay/overlay-root";
export * from "./overlay/composer";
export * from "./overlay/panel";
export * from "./overlay/thread-detail";
export * from "./overlay/unlock-dialog";

export const VERSION = "0.1.0";
