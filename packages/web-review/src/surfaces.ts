"use client";

/**
 * `Composer`, `Panel`, `ThreadDetail`, `UnlockDialog` — the four default UI
 * surfaces `ReviewOverlay` wires in automatically (see
 * `./overlay/default-surfaces`'s `loadWiredOverlayRoot`), exported here as
 * values so a consumer can replace just one via `renderComposer` /
 * `renderPanel` / `renderUnlockDialog` while still reusing the other three
 * stock — see "Customizing a surface" in the README.
 *
 * On their own subpath, not the main `.` entry, even though the override
 * feature they exist for is unchanged: `.` and this file both carry
 * `"use client"`, and Next.js's webpack integration forces the FULL export
 * list of any `"use client"` file reachable in a Server Component's module
 * graph into the client bundle — every named export gets wrapped in a
 * client reference, independent of whether the importing code actually
 * uses it (confirmed against Next's own `next-flight-client-entry-loader`
 * source). That makes a `"use client"` file's own export LIST, not how
 * tsup chunks the implementation behind it, the thing that decides what a
 * consumer's bundler downloads. Splitting these four onto their own
 * subpath means a consumer who imports `createHttpAdapter` (or anything
 * else) from `.` no longer pulls them in — only a consumer who actually
 * imports from here pays for them. See "Bundle cost" in the README for the
 * measurement.
 */

export * from "./overlay/composer";
export * from "./overlay/panel";
export * from "./overlay/thread-detail";
export * from "./overlay/unlock-dialog";
