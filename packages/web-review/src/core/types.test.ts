import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../anchor";
import {
  ReviewApiError,
  isFeatureDisabled,
  isLocked,
  unlockErrorMessage,
} from "./adapter";
import type { ReviewAdapter } from "./adapter";
import { resolveConfig } from "./config";
import { DEFAULT_CATEGORIES } from "./types";
import type { ReviewCategoryDef, ReviewThreadView } from "./types";

/**
 * Minimal adapter satisfying every required `ReviewAdapter` method, so
 * tests can vary only the optional `unlock`/`uploadScreenshot` methods
 * without repeating the required boilerplate each time.
 */
function makeAdapter(
  overrides: Partial<
    Pick<ReviewAdapter, "unlock" | "uploadScreenshot">
  > = {},
): ReviewAdapter {
  return {
    // None of these are ever invoked in this file — they exist only to
    // satisfy `ReviewAdapter`'s required methods, so they stay synchronous
    // (no real `await`) rather than declared `async` with nothing to await.
    listThreads: () => Promise.resolve([]),
    getThread: () => {
      throw new ReviewApiError(404, "not found");
    },
    createThread: (input) => Promise.resolve(makeThread(input.category)),
    addComment: () => {
      throw new ReviewApiError(404, "not found");
    },
    setStatus: (_id, status) => Promise.resolve(makeThread("bug", status)),
    ...overrides,
  };
}

function makeThread(
  category: string,
  status: "open" | "resolved" = "open",
): ReviewThreadView {
  return {
    id: "t1",
    project: "web",
    url: "https://example.com/",
    urlKey: "/",
    locale: null,
    route: null,
    title: null,
    category,
    anchor: {
      selector: "#x",
      textHint: "",
      tagName: "div",
      classes: [],
      ancestorPath: [],
      rect: { x: 0, y: 0, w: 0, h: 0 },
      offsetPct: { x: 0, y: 0 },
      viewport: { w: 0, h: 0, dpr: 1, scrollW: 0, scrollH: 0 },
      urlKey: "/",
      href: "https://example.com/",
    },
    viewport: null,
    status,
    authorId: "a1",
    authorName: "Ada",
    screenshotUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    comments: [],
    commentCount: 0,
  };
}

describe("resolveConfig", () => {
  it("applies every default when only adapter is given", () => {
    const adapter = makeAdapter();
    const resolved = resolveConfig({ adapter });

    expect(resolved.adapter).toBe(adapter);
    expect(resolved.project).toBe("web");
    expect(resolved.categories).toBe(DEFAULT_CATEGORIES);
    expect(resolved.storagePrefix).toBe("r3wr");
    // This adapter has no `uploadScreenshot`, so even the `screenshots`
    // default of `true` resolves down to `false` — see the `screenshots`
    // describe block below for the full truth table.
    expect(resolved.screenshots).toBe(false);
    expect(resolved.localeFromHref("https://example.com/")).toBeNull();
    // Default is this package's own `normalizeUrl` — see the seam note on
    // `ResolvedReviewConfig.urlKeyFromHref` in ./config.
    expect(resolved.urlKeyFromHref).toBe(normalizeUrl);
    expect(resolved.urlKeyFromHref("https://example.com/tr/flyer?utm_source=x")).toBe(
      "/tr/flyer",
    );
    expect(resolved.requireUnlock).toBe(false);
    expect(resolved.enabled).toBeUndefined();
    expect(resolved.debug).toBe(false);
  });

  it("respects every explicit value", () => {
    const adapter = makeAdapter({
      unlock: async () => {},
    });
    const categories: ReviewCategoryDef[] = [{ id: "custom", label: "Custom" }];
    const localeFromHref = (href: string) => (href.includes("/tr/") ? "tr" : "en");
    const urlKeyFromHref = (href: string) => new URL(href).pathname;

    const resolved = resolveConfig({
      adapter,
      project: "docs",
      categories,
      storagePrefix: "custom-prefix",
      screenshots: false,
      localeFromHref,
      urlKeyFromHref,
      requireUnlock: false,
      enabled: true,
      debug: true,
    });

    expect(resolved.project).toBe("docs");
    expect(resolved.categories).toBe(categories);
    expect(resolved.storagePrefix).toBe("custom-prefix");
    expect(resolved.screenshots).toBe(false);
    expect(resolved.localeFromHref).toBe(localeFromHref);
    expect(resolved.urlKeyFromHref).toBe(urlKeyFromHref);
    // Explicit `false` must win even though `adapter.unlock` is present.
    expect(resolved.requireUnlock).toBe(false);
    expect(resolved.enabled).toBe(true);
    expect(resolved.debug).toBe(true);
  });

  it("derives requireUnlock true when adapter.unlock is present", () => {
    const adapter = makeAdapter({ unlock: async () => {} });
    expect(resolveConfig({ adapter }).requireUnlock).toBe(true);
  });

  it("derives requireUnlock false when adapter.unlock is absent", () => {
    const adapter = makeAdapter();
    expect(resolveConfig({ adapter }).requireUnlock).toBe(false);
  });

  describe("screenshots", () => {
    // `screenshots` must resolve `true` only when screenshots are both
    // wanted (`config.screenshots` unset or `true`) and possible
    // (`adapter.uploadScreenshot` implemented). An explicit `false` always
    // wins, even when the adapter could upload.
    it("resolves false when unset and the adapter has no uploadScreenshot", () => {
      const adapter = makeAdapter();
      expect(typeof adapter.uploadScreenshot).toBe("undefined");
      expect(resolveConfig({ adapter }).screenshots).toBe(false);
    });

    it("resolves true when unset and the adapter has uploadScreenshot", () => {
      const adapter = makeAdapter({ uploadScreenshot: () => Promise.resolve(null) });
      expect(resolveConfig({ adapter }).screenshots).toBe(true);
    });

    it("resolves false when explicitly true but the adapter has no uploadScreenshot", () => {
      const adapter = makeAdapter();
      expect(
        resolveConfig({ adapter, screenshots: true }).screenshots,
      ).toBe(false);
    });

    it("resolves false when explicitly false even though the adapter has uploadScreenshot", () => {
      const adapter = makeAdapter({ uploadScreenshot: () => Promise.resolve(null) });
      expect(
        resolveConfig({ adapter, screenshots: false }).screenshots,
      ).toBe(false);
    });
  });
});

describe("ReviewApiError helpers", () => {
  describe("isLocked", () => {
    it("is true for a 401 ReviewApiError", () => {
      expect(isLocked(new ReviewApiError(401, "locked"))).toBe(true);
    });

    it("is false for other statuses", () => {
      expect(isLocked(new ReviewApiError(404, "not found"))).toBe(false);
      expect(isLocked(new ReviewApiError(500, "boom"))).toBe(false);
    });

    it("is false for non-ReviewApiError values", () => {
      expect(isLocked(new Error("plain"))).toBe(false);
      expect(isLocked(undefined)).toBe(false);
      expect(isLocked("401")).toBe(false);
    });
  });

  describe("isFeatureDisabled", () => {
    it("is true only when BOTH status 404 and code 'feature_disabled' are present", () => {
      expect(
        isFeatureDisabled(new ReviewApiError(404, "off", "feature_disabled")),
      ).toBe(true);
    });

    it("is false on a 404 with a different or missing code", () => {
      expect(isFeatureDisabled(new ReviewApiError(404, "missing"))).toBe(
        false,
      );
      expect(
        isFeatureDisabled(new ReviewApiError(404, "other", "some_other_code")),
      ).toBe(false);
    });

    // The defect this guards against: `not_found` (an unknown/malformed
    // thread id — see `src/next/routes.ts`) must NOT be treated as the
    // feature being disabled, even though both are 404s. This package used
    // to have only one 404 code, `not_found`, which made this
    // indistinguishable from the kill switch — see `isFeatureDisabled`'s
    // doc comment in `./adapter` and `src/next/routes.test.ts`'s "404 code
    // discrimination" suite for the end-to-end regression proof.
    it("is false on a 404 carrying code 'not_found' (an unknown thread, not a disabled feature)", () => {
      expect(
        isFeatureDisabled(new ReviewApiError(404, "missing", "not_found")),
      ).toBe(false);
    });

    it("is false on a 404 carrying code 'screenshots_unsupported'", () => {
      expect(
        isFeatureDisabled(
          new ReviewApiError(404, "no screenshots", "screenshots_unsupported"),
        ),
      ).toBe(false);
    });

    it("is false on a non-404 status even with code 'feature_disabled'", () => {
      expect(
        isFeatureDisabled(new ReviewApiError(400, "bad", "feature_disabled")),
      ).toBe(false);
    });

    it("is false for non-ReviewApiError values", () => {
      expect(isFeatureDisabled(new Error("plain"))).toBe(false);
    });
  });

  describe("unlockErrorMessage", () => {
    it("mentions the wait time on a 429 with retryAfterSec", () => {
      expect(
        unlockErrorMessage(new ReviewApiError(429, "slow down", undefined, 30)),
      ).toBe("Too many attempts. Try again in 30s.");
    });

    it("falls back to a generic wait message on a 429 without retryAfterSec", () => {
      expect(unlockErrorMessage(new ReviewApiError(429, "slow down"))).toBe(
        "Too many attempts. Try again shortly.",
      );
    });

    it("reports an incorrect password on 401", () => {
      expect(unlockErrorMessage(new ReviewApiError(401, "locked"))).toBe(
        "Incorrect password.",
      );
    });

    it("reports the feature as disabled on 404", () => {
      // `unlockErrorMessage` reacts to status alone, not the code — but the
      // real 404 `/unlock` produces on a disabled feature carries
      // `feature_disabled` (see `src/next/routes.ts`), so the fixture uses
      // that code here too rather than a stale/unrelated one.
      expect(
        unlockErrorMessage(new ReviewApiError(404, "off", "feature_disabled")),
      ).toBe("Review is not enabled on this deployment.");
    });

    it("falls back to a generic message for an unknown error", () => {
      expect(unlockErrorMessage(new Error("network down"))).toBe(
        "Could not unlock. Check your connection and try again.",
      );
      expect(unlockErrorMessage(undefined)).toBe(
        "Could not unlock. Check your connection and try again.",
      );
    });
  });
});
