// Node-safe server entry point: zod validators, row-to-wire serializers,
// HMAC shared-password auth helpers, an in-memory unlock rate limiter, and
// PNG validation. No React, no Next, no DOM globals — this is consumed by
// Express, Hono, Fastify, and plain Node as much as by Next.js.
// `../next/routes.ts` wraps these primitives in a Next.js route-handler
// factory; this entry stays framework-agnostic.
//
// The wire types and the ReviewAdapter contract (plus ReviewApiError and
// its helpers) are re-exported here too: server code needs the wire types
// to write serializers, and needs ReviewAdapter to type-check its own
// adapter implementation. `Blob` (used by `ReviewAdapter.uploadScreenshot`)
// is a Node 18+ global, so this stays DOM-free despite that signature.

export * from "../core/types";
export * from "../core/adapter";

export * from "./validation";
export * from "./serialize";
export * from "./access";
export * from "./rate-limit";
export * from "./png";

// Re-exported from `../version`, the single source for the package version —
// see its header. It imports nothing, so this entry stays as React-free,
// Next-free and DOM-free as the rest of this file promises.
export { VERSION } from "../version";
