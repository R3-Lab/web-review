"use client";

// Client entry point: browser review overlay (pin placement, threaded
// comments UI), the DOM anchoring engine, wire types, and the React
// adapter used to mount the overlay in a consuming app. `ReviewOverlay` is
// the mount gate a consumer's layout imports; it renders nothing until
// switched on, and its shell (pins, highlights, drift, keyboard handling,
// polling) lazy-loads behind it. `Composer`, `Panel`, `ThreadDetail`, and
// `UnlockDialog` are wired in as `ReviewOverlay`'s defaults for
// `renderComposer` / `renderPanel` / `renderUnlockDialog` — see
// `./overlay/overlay-root` for the exact seam each one implements against —
// but are exported as VALUES from `@r3lab/web-review/surfaces`, not this
// entry: see that file's own header for why the split exists (this file and
// it both carry `"use client"`, and Next's webpack integration forces the
// full export list of any `"use client"` file into a consumer's client
// bundle, independent of what's actually used — so keeping them off `.`
// means importing `createHttpAdapter`, or anything else, from here no
// longer drags them in under webpack). See "Bundle cost" in the README for
// the measurement and "Customizing a surface" for how to override one.

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

export const VERSION = "0.1.0";
