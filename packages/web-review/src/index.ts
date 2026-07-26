"use client";

// Client entry point: browser review overlay (pin placement, threaded
// comments UI), the DOM anchoring engine, wire types, and the React
// adapter used to mount the overlay in a consuming app. `ReviewOverlay` is
// the mount gate a consumer's layout imports; it renders nothing until
// switched on, and its shell (pins, highlights, drift, keyboard handling,
// polling — WP4a) lazy-loads behind it. The composer, thread panel, thread
// detail, and unlock dialog (WP4b) plug into `ReviewOverlay`'s
// `renderComposer` / `renderPanel` / `renderUnlockDialog` props — see
// `./overlay/overlay-root` for the exact seam each one implements against.

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
export * from "./overlay/overlay-root";

export const VERSION = "0.1.0";
