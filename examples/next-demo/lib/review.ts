/**
 * One `createReviewRouteHandlers` call, re-exported from every
 * `app/api/review/.../route.ts` file — see that factory's own doc comment in
 * `@r3lab/web-review/next` for the full wiring example this mirrors.
 */

import { createReviewRouteHandlers } from "@r3lab/web-review/next";
import { store } from "./review-store";

export const review = createReviewRouteHandlers({
  store,
  access: {
    password: process.env.REVIEW_PASSWORD,
    secret: process.env.REVIEW_SECRET,
  },
});
