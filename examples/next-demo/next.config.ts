import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The E2E suite (WP11) builds two variants of this app in parallel — one
  // with NEXT_PUBLIC_REVIEW_ENABLED=1, one without (scenario 8: "disabled
  // overlay costs nothing") — and must not let either clobber the other or
  // a developer's own `.next` from `pnpm dev`/`pnpm build`. Playwright's
  // webServer config sets NEXT_DIST_DIR for both variants; everyone else
  // (dev, build, CI) gets the normal `.next`.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
