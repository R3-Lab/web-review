"use client";

// Client entry point: browser review overlay (pin placement, threaded
// comments UI), the DOM anchoring engine, wire types, and the React
// adapter used to mount the overlay in a consuming app. The overlay UI
// itself (pins, highlights, composer, panel) is implemented in later work
// packages (WP4a/WP4b); this entry already carries the browser-side
// plumbing it will sit on top of — identity, screenshot capture, the HTTP
// `ReviewAdapter`, and the focus-trap / location hooks.

export * from "./core/types";
export * from "./core/adapter";
export * from "./core/config";
export * from "./anchor";
export * from "./client/identity";
export * from "./client/screenshot";
export * from "./client/http-adapter";
export * from "./client/use-focus-trap";
export * from "./client/use-location";

export const VERSION = "0.1.0";
