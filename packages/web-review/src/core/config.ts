/**
 * Consumer-facing configuration for the review overlay.
 *
 * `adapter` is the only required field — everything else has a sensible
 * default. Call {@link resolveConfig} once (typically where the overlay is
 * mounted) to get a fully-defaulted config, so the rest of the package
 * reads non-optional fields instead of re-checking for `undefined`
 * everywhere.
 */

import { normalizeUrl } from "../normalize-url";
import type { ReviewAdapter } from "./adapter";
import { DEFAULT_CATEGORIES } from "./types";
import type { ReviewCategoryDef } from "./types";

export interface ReviewConfig {
  /** How the overlay talks to your storage. The only required field. */
  adapter: ReviewAdapter;
  /** Namespaces threads/comments when one deployment hosts multiple apps. Default `"web"`. */
  project?: string;
  /** Categories offered when opening a new thread. Default {@link DEFAULT_CATEGORIES}. */
  categories?: ReviewCategoryDef[];
  /** Prefix for the overlay's localStorage keys (reviewer identity, dismissed prompts, …). Default `"r3wr"`. */
  storagePrefix?: string;
  /**
   * Whether to attempt screenshot capture on new threads. Default `true`,
   * but `resolveConfig` resolves this down to `false` whenever
   * `adapter.uploadScreenshot` is absent — with no upload method there is
   * nowhere to send the capture. See `ResolvedReviewConfig.screenshots`.
   * An explicit `false` here always wins, regardless of what the adapter
   * supports.
   */
  screenshots?: boolean;
  /**
   * Derive a locale from the current page's `href`, stored on
   * `ReviewThreadView.locale`. Default `() => null` (no locale).
   */
  localeFromHref?: (href: string) => string | null;
  /**
   * Derive the normalized page key (`ReviewThreadView.urlKey`) that groups
   * threads by page. Default: this package's own `normalizeUrl` — see the
   * note on `ResolvedReviewConfig.urlKeyFromHref` below.
   */
  urlKeyFromHref?: (href: string) => string;
  /**
   * Require a successful `adapter.unlock` call before the overlay is
   * usable. Default: `true` when `adapter.unlock` is present, `false`
   * otherwise — there is nothing to unlock against when the adapter
   * doesn't implement it.
   */
  requireUnlock?: boolean;
  /**
   * How often, in milliseconds, the overlay re-fetches the current page's
   * threads so two reviewers on the same page see each other's pins.
   * Default `30000`.
   *
   * `0` (or any value `<= 0`) disables the interval — and ONLY the
   * interval. The overlay always refetches when the page regains focus or
   * becomes visible again, which is the case a poll mostly exists to cover
   * (switch tab, come back, expect to be current), so `0` means "refresh
   * when I come back to the page, not on a clock", never "never refresh".
   * That is the setting for an app that pays per request, or one where the
   * overlay shares a rate limit with the host page.
   */
  pollMs?: number;
  /**
   * Explicit override of whether the overlay mounts at all. Leave unset to
   * defer to the mount gate's own default (e.g. preview-deployment
   * detection, owned by the client runtime that calls `resolveConfig`);
   * set `true`/`false` here to force it on or off regardless of that
   * default.
   */
  enabled?: boolean;
  /** Gates the overlay's console diagnostics. Default `false`. */
  debug?: boolean;
}

/**
 * `ReviewConfig` with every computable default filled in. Downstream code
 * should consume this, not `ReviewConfig`, so it never needs to repeat the
 * defaulting logic in `resolveConfig`.
 */
export interface ResolvedReviewConfig {
  adapter: ReviewAdapter;
  project: string;
  categories: ReviewCategoryDef[];
  storagePrefix: string;
  /**
   * `true` only when screenshots are both wanted (`ReviewConfig.screenshots`
   * is `true` or unset) and possible (`adapter.uploadScreenshot` is
   * implemented). An explicit `ReviewConfig.screenshots: false` always
   * resolves to `false` here, even when the adapter can upload.
   */
  screenshots: boolean;
  localeFromHref: (href: string) => string | null;
  /**
   * Defaults to this package's own `normalizeUrl` (`../normalize-url`,
   * re-exported from `../anchor` — see that module's header for why
   * `normalizeUrl` lives in its own file): origin and
   * hash stripped, path kept as-is (including any locale prefix — see the
   * doc comment on `normalizeUrl` for why), tracking query params (utm_*,
   * fbclid, …) dropped, remaining params sorted for a stable key. Override
   * via `ReviewConfig.urlKeyFromHref` for a different grouping.
   */
  urlKeyFromHref: (href: string) => string;
  requireUnlock: boolean;
  /**
   * Poll cadence in milliseconds, defaulted to `30000`. Passed through
   * verbatim, including a non-positive value: "disabled" is a state the
   * overlay has to be able to read off this field, so `resolveConfig` does
   * not clamp it to some minimum. `<= 0` switches the interval off while
   * leaving the focus/visibility refetch running — see
   * `ReviewConfig.pollMs`.
   */
  pollMs: number;
  /**
   * Left optional deliberately: `undefined` means "no override was given",
   * and the mount gate (owned outside this file — see `ReviewConfig.enabled`)
   * decides the actual default from there.
   */
  enabled?: boolean;
  debug: boolean;
}

/** Fill in every default on `config`, producing a fully-resolved config. */
export function resolveConfig(config: ReviewConfig): ResolvedReviewConfig {
  return {
    adapter: config.adapter,
    project: config.project ?? "web",
    categories: config.categories ?? DEFAULT_CATEGORIES,
    storagePrefix: config.storagePrefix ?? "r3wr",
    screenshots: (config.screenshots ?? true) && config.adapter.uploadScreenshot != null,
    localeFromHref: config.localeFromHref ?? (() => null),
    urlKeyFromHref: config.urlKeyFromHref ?? normalizeUrl,
    requireUnlock: config.requireUnlock ?? config.adapter.unlock != null,
    pollMs: config.pollMs ?? 30_000,
    enabled: config.enabled,
    debug: config.debug ?? false,
  };
}
