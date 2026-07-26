"use client";

// Client entry point: browser review overlay (pin placement, threaded
// comments UI), the DOM anchoring engine, wire types, and the React
// adapter used to mount the overlay in a consuming app. Implemented in
// later work packages (WP1-WP4).

export * from "./core/types";
export * from "./core/adapter";
export * from "./core/config";
export * from "./anchor";

export const VERSION = "0.1.0";
