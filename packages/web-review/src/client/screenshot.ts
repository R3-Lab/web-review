"use client";

/**
 * Screenshot capture — rasterizes the pinned element (+ a little surrounding
 * context) as a PNG Blob, client-side and async, so the screenshot shows
 * exactly what the reviewer pinned.
 *
 * Ported from a working single-app review tool's `feedback/screenshot.ts`,
 * with one structural change required by this package: `@zumer/snapdom` is
 * an OPTIONAL peer dependency (see `package.json` `peerDependenciesMeta`),
 * so it is never imported at the top of this module. It is loaded via a
 * dynamic `import()` INSIDE `captureScreenshot`, the only place it's used.
 * A consumer who never calls `captureScreenshot` (screenshots disabled, or
 * `adapter.uploadScreenshot` absent — see `ResolvedReviewConfig.screenshots`)
 * never triggers module resolution for snapdom at all, so they can use the
 * rest of this package without installing it and without a module-resolution
 * error. tsup's `external: ["@zumer/snapdom"]` (see `tsup.config.ts`) then
 * leaves that dynamic `import()` call as-is in the bundle rather than
 * inlining the dependency, so it stays a real runtime import, not a
 * bundle-time one — see the package README / WP3 report for the `grep`
 * proving no static import survives into `dist/`.
 *
 * We deliberately do NOT rasterize the whole document and crop to a
 * viewport region: snapdom re-renders a DOM clone whose layout can reflow
 * differently from the live page (and can exceed the browser's 16384px
 * canvas limit), so a viewport crop is unreliable and can show the wrong
 * region. Rasterizing the pinned element itself sidesteps both problems.
 *
 * Hard contract: this function NEVER throws and NEVER blocks submission —
 * on ANY failure (snapdom missing, CORS-tainted canvas, element too small,
 * timeout, …) it logs (gated on `options.debug`) and returns `null`, and the
 * caller creates the thread without an image. CORS-blocked images degrade to
 * a placeholder (snapdom's `fallbackURL`) rather than tainting the canvas.
 * The overlay's own DOM is excluded via `OVERLAY_ATTR` so it never appears
 * in the shot.
 */

import { OVERLAY_ATTR } from "../anchor";

/** Options controlling a single `captureScreenshot` call. */
export interface CaptureScreenshotOptions {
  /** Gate console diagnostics on failure paths. Default `false`. */
  debug?: boolean;
}

/**
 * A placeholder for CORS images snapdom can't inline. An inline SVG
 * data: URI is used instead of a network placeholder image so the capture
 * makes no network request of its own — a consumer's CSP `img-src`
 * allowlist would otherwise log a violation for every blocked image.
 */
const FALLBACK_URL = ({
  width = 300,
  height = 150,
}: {
  width?: number;
  height?: number;
}) =>
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="#eee"/>` +
      `<text x="50%" y="50%" fill="#999" font-family="sans-serif" font-size="14"` +
      ` text-anchor="middle" dominant-baseline="middle">image unavailable</text></svg>`,
  );

/**
 * The server rejects any PNG smaller than this with
 * `400 {"error":"screenshot_too_small"}`, on the grounds that a sliver of a
 * page is worse than no screenshot at all. Expressed in CSS px: snapdom
 * rasterizes at `devicePixelRatio` (≥1), so an element this size never
 * encodes below the limit. A smaller floor (e.g. 96px) would, at dpr 1,
 * produce a 96×96 PNG — every one of which the server would refuse.
 */
const MIN_CAPTURE_PX = 200;

/**
 * Pick the element to rasterize: the pinned element, expanded to a parent
 * for context when the pinned element is small (e.g. a heading or an inline
 * span) — but never so far up that we capture the whole page.
 */
function pickCaptureTarget(target?: Element | null): Element | null {
  if (!target) return null;
  let el: Element = target;
  const maxH =
    (typeof window !== "undefined" ? window.innerHeight : 800) * 1.3;
  while (
    el.parentElement &&
    el !== document.body &&
    el !== document.documentElement
  ) {
    const r = el.getBoundingClientRect();
    // Enough context, and comfortably over the server's floor.
    if (r.height >= MIN_CAPTURE_PX && r.width >= MIN_CAPTURE_PX) break;
    const pr = el.parentElement.getBoundingClientRect();
    if (pr.height > maxH) break; // parent too big — keep the current element
    el = el.parentElement;
  }
  return el;
}

function debugWarn(debug: boolean | undefined, ...args: unknown[]): void {
  if (debug) console.warn(...args);
}

/**
 * Capture the pinned element (+context) as a PNG Blob, or `null` on any
 * error — including snapdom being uninstalled. Pass the resolved anchor
 * element; falls back to `<html>` only if none is given. Strictly
 * client-side — call only from an event handler in a client component,
 * never during SSR.
 */
export async function captureScreenshot(
  target?: Element | null,
  options?: CaptureScreenshotOptions,
): Promise<Blob | null> {
  const debug = options?.debug;
  try {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return null;
    }
    const el = pickCaptureTarget(target) ?? document.documentElement;

    // If expanding for context still couldn't clear the server's floor (a
    // tiny element whose only parent is taller than the whole viewport),
    // stop here. Rasterizing and uploading would just buy a 400
    // `screenshot_too_small`, and the outcome either way is a thread with
    // no image — so skip the work rather than spend a round trip
    // discovering it.
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_CAPTURE_PX || rect.height < MIN_CAPTURE_PX) {
      debugWarn(
        debug,
        `[web-review] capture target is ${Math.round(rect.width)}×${Math.round(rect.height)}, ` +
          `below the ${MIN_CAPTURE_PX}px floor; submitting without a screenshot`,
      );
      return null;
    }

    // Dynamic import: see the file header for why this must never become a
    // top-level import. A consumer who hasn't installed `@zumer/snapdom`
    // hits this rejection only when they actually try to capture — never at
    // module load.
    let snapdomModule: typeof import("@zumer/snapdom");
    try {
      snapdomModule = await import("@zumer/snapdom");
    } catch (err) {
      debugWarn(
        debug,
        "[web-review] @zumer/snapdom is not installed; submitting without a screenshot",
        err,
      );
      return null;
    }
    const { snapdom } = snapdomModule;

    // snapdom can occasionally produce a canvas over the browser per-side
    // limit (16384px) for very large targets — an over-limit canvas becomes
    // an undecodable image. Retry at progressively lower scales until
    // decode works.
    const dpr = window.devicePixelRatio || 1;
    const candidates = [dpr, 1.5, 1, 0.75, 0.5].filter(
      (s, i, a) => s <= dpr + 1e-6 && a.indexOf(s) === i,
    );

    for (const scale of candidates) {
      try {
        const img = await snapdom.toPng(el, {
          scale,
          embedFonts: true,
          fallbackURL: FALLBACK_URL,
          exclude: [`[${OVERLAY_ATTR}]`],
        });
        await img.decode();
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        if (!iw || !ih) continue;

        // The element IS the region — no crop. Re-encode to a PNG Blob.
        // Each branch below gets its OWN concretely-typed canvas rather
        // than sharing one `OffscreenCanvas | HTMLCanvasElement`-typed
        // binding across both: that union narrows unreliably once a value
        // crosses into the executor closure passed to `new Promise` below,
        // so keeping the two canvas kinds in entirely separate branches
        // (each with its own unambiguous type) is more robust than leaning
        // on control-flow narrowing to hold.
        if (typeof OffscreenCanvas !== "undefined") {
          const canvas = new OffscreenCanvas(iw, ih);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.drawImage(img, 0, 0);
          return await canvas.convertToBlob({ type: "image/png" });
        }

        const canvas = Object.assign(document.createElement("canvas"), {
          width: iw,
          height: ih,
        });
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.drawImage(img, 0, 0);
        return await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/png"),
        );
      } catch (err) {
        debugWarn(
          debug,
          "[web-review] element capture failed at scale",
          scale,
          "— retrying lower",
          err,
        );
      }
    }

    debugWarn(
      debug,
      "[web-review] screenshot capture failed; submitting without one",
    );
    return null;
  } catch (err) {
    // Belt-and-braces: nothing above should reach here, but the hard
    // contract is "never throws" — an unforeseen failure still degrades to
    // no screenshot rather than blocking thread creation.
    debugWarn(
      debug,
      "[web-review] unexpected screenshot capture error; submitting without one",
      err,
    );
    return null;
  }
}
