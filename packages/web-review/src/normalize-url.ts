/**
 * `normalizeUrl` — split out of `./anchor` purely for bundle shape, not for
 * any change in behavior or ownership: this is still the DOM
 * anchoring engine's page-key derivation, ported unchanged from the same
 * reference implementation `./anchor`'s own header describes. It lives in
 * its own module because `./core/config`'s `resolveConfig` needs it as the
 * default `urlKeyFromHref` and — unlike everything else `./anchor`
 * exports — `resolveConfig` runs unconditionally, before any gate check,
 * every time a consumer mounts `ReviewOverlay` (`../overlay/review-overlay`)
 * or `../next/client`'s Next entry (see the "hooks can't be called after an
 * early return" note on both). Keeping `normalizeUrl` co-located inside
 * `./anchor` — alongside `OVERLAY_ATTR`, `captureAnchor`, `resolveAnchor`,
 * and the rest of the (framework-agnostic but still substantial) DOM
 * anchoring engine — meant a bundler that sees `resolveConfig` import
 * `normalizeUrl` from `./anchor` has to decide how much of `./anchor` to
 * pull into whichever chunk reaches `resolveConfig` eagerly. esbuild's
 * (and Next/webpack's) chunk-splitting, when the SAME module is reachable
 * both synchronously (this eager path) and asynchronously (`./anchor`'s
 * own internal call to `normalizeUrl` from `captureAnchor`, reached only
 * through the overlay's lazy boundary), keeps the module as ONE physical
 * chunk visible to both sides — so the eager path ended up pulling in the
 * WHOLE shared chunk, `OVERLAY_ATTR` included, even though `resolveConfig`
 * only ever calls `normalizeUrl` itself. Measured directly: before this
 * split, Next's webpack build of `examples/next-demo`'s disabled variant
 * (the overlay switched off, never mounted) still had `data-r3-review` —
 * `OVERLAY_ATTR`'s value, a distinctive fingerprint that survives
 * minification because it's a string literal, not a renameable identifier
 * — inside `app/layout-*.js` (~15.9 KB), the ALWAYS-loaded layout bundle.
 * Splitting `normalizeUrl` into this standalone module gives the bundler a
 * physically separate file for the one function the eager path actually
 * needs, so the eager chunk it pulls in now contains only this file (a few
 * hundred bytes), and the rest of `./anchor` — genuinely large, and
 * genuinely reached only through the overlay's `import()` boundary — stays
 * out of it. See `README.md`'s "Bundle cost" section for the measured
 * before/after.
 *
 * `./anchor` still re-exports `normalizeUrl` (and still calls it
 * internally from `captureAnchor`, to stamp `Anchor.urlKey`) so nothing
 * about this package's public API — `import { normalizeUrl } from
 * "@r3lab/web-review"` or `"@r3lab/web-review"`'s own `./anchor` re-export
 * — changes; only where the implementation physically lives.
 */

/**
 * Normalize an href into a stable page key: strip the origin and hash, keep
 * the path — INCLUDING any locale prefix — plus a deterministic, sorted set
 * of significant query params (tracking/ephemeral params dropped).
 *
 * Keeping the prefix is deliberate: `/about` and `/tr/hakkimizda` (or
 * whatever segments a consumer's locales use) are different pages with
 * independently-written copy, and a pin left on one locale's wording must
 * never surface on another locale's page. This package has no notion of
 * what a consumer's locale segments are — see `./anchor`'s
 * `localeFromPathPrefix`, which takes the locale list as a parameter rather
 * than this module hard-coding one — so `normalizeUrl` has no way to
 * special-case them even if it wanted to, and stripping blindly would risk
 * merging pages that happen to share a first path segment that isn't a
 * locale at all.
 */
export function normalizeUrl(href: string): string {
  let url: URL;
  try {
    url = new URL(href, "http://x");
  } catch {
    return href;
  }
  const segs = url.pathname.split("/").filter(Boolean);
  const path = "/" + segs.join("/");

  const keep: [string, string][] = [];
  url.searchParams.forEach((v, k) => {
    if (isSignificantParam(k)) keep.push([k, v]);
  });
  keep.sort(([a], [b]) => a.localeCompare(b));
  const query = keep.length
    ? "?" + keep.map(([k, v]) => `${k}=${v}`).join("&")
    : "";

  return (path === "/" ? "/" : path.replace(/\/$/, "")) + query;
}

/**
 * Drop tracking / ephemeral params from the page key (utm_*, fbclid, session
 * tokens, …); keep functional ones (tab, page, id, …).
 */
function isSignificantParam(key: string): boolean {
  const k = key.toLowerCase();
  if (k.startsWith("utm_")) return false;
  const drop = new Set([
    "fbclid",
    "gclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "ref",
    "ref_src",
    "session",
    "token",
    "_ga",
  ]);
  return !drop.has(k);
}
