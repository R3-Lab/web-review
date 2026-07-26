// Node-safe server entry point: zod validators, row-to-wire serializers,
// HMAC shared-password auth helpers, and the Next.js route-handler
// factory that takes user-supplied store functions. No React, no Next,
// no DOM. Implemented in later work packages (WP6-WP7).
//
// The wire types and the ReviewAdapter contract (plus ReviewApiError and
// its helpers) are re-exported here too: server code needs the wire types
// to write serializers, and needs ReviewAdapter to type-check its own
// adapter implementation. `Blob` (used by `ReviewAdapter.uploadScreenshot`)
// is a Node 18+ global, so this stays DOM-free despite that signature.

export * from "../core/types";
export * from "../core/adapter";

export const VERSION = "0.1.0";
