# Auth model

**Part of [`@r3lab/web-review`](https://github.com/R3-Lab/web-review/blob/main/README.md)** — an
in-page review overlay for React and Next.js apps that ships no server and no
database. This page covers how access to review data is gated: a shared
password instead of reviewer accounts, the signed cookie it mints, and the
helpers you use to apply the same gate to routes this package doesn't provide.
If you landed here from a search engine, the
[README](https://github.com/R3-Lab/web-review/blob/main/README.md) introduces
the package and shows the five-minute wiring.

**On this page:** [The gate](#the-gate) ·
[`requireReviewAccess`](#protecting-your-own-routes-requirereviewaccess) ·
[`readCookieValue`](#readcookievalue) ·
[The full server surface](#the-rest-of-the-server-entry)

---

## The gate

<img src="https://raw.githubusercontent.com/R3-Lab/web-review/main/docs/images/unlock.png" width="378" alt="The shared-password unlock dialog, with the locked Review launcher behind it.">

*A reviewer unlocks with the shared password — there's no account to
create.*

A shared-password gate, not per-reviewer accounts — see the [database
schema](https://github.com/R3-Lab/web-review/blob/main/docs/api.md#two-deliberate-design-decisions)
note on why. A successful `POST /unlock` mints a
signed, `httpOnly` cookie (`sameSite: "lax"`, `secure` on by default when
`NODE_ENV=production`, 7-day expiry baked into the signature so a reviewer
can't extend it by editing the cookie).

- **Fail-closed kill switch.** The feature is off unless *both*
  `REVIEW_PASSWORD` and a signing secret are set — missing either takes
  every route (including for a caller your own `isAdmin` predicate would
  otherwise admit) to 404. There is deliberately no open fallback.
- **Domain-separated, password-bound signing key.** The cookie isn't signed
  with the raw secret; the HMAC key is derived from the secret plus a
  fixed, package-specific domain string plus a hash of the current password.
  Domain separation means a signing oracle here can't forge other session
  data you sign with the same secret. Password binding means rotating
  `REVIEW_PASSWORD` invalidates every outstanding cookie.
- **Optional admin bypass.** Pass `isAdmin` to `createReviewRouteHandlers`
  to let your own authenticated admins in without the shared password. It's
  checked only after the signed cookie fails (so the common reviewer path
  costs zero extra lookups), and a predicate that throws is treated as "not
  admin" rather than a 500.
- **Rate limiting is per-process.** The built-in unlock limiter (10 attempts
  per 10 minutes per IP, by default) is a plain in-memory `Map` — there's no
  shared store (no Redis, no KV). On serverless/edge, a distributed attacker
  hitting several warm instances gets the full attempt budget on *each*, and
  the counter resets on cold start. It stops a naive single-client brute
  force, which is the realistic threat for a shared password on a preview
  deployment; if this guards anything more valuable, swap in a shared store.

The gate's configuration is one object, `ReviewAccessOptions` — `password`,
`secret`, and optionally `cookiePrefix` (default `"r3wr"`, so the cookie is
`r3wr.access`) and `secureCookie`. It's the type of `createReviewRouteHandlers`'
`access` option and of the standalone guard's `access` option, deliberately:
one object configures both, with no second, drifting copy of the
password/secret/prefix triple.

## Protecting your own routes: `requireReviewAccess`

*New in 0.3.0.* One call that answers "may this request see review data?" for
a plain Web `Request` — no config assembly, no header parsing, no
`next/server`:

```ts
function requireReviewAccess(
  req: Request,
  options: RequireAccessOptions,
): Promise<RequestAccessVerdict>;
```

This is the guard the route factory runs before every protected route,
exported so that the auxiliary routes you inevitably add — a screenshot
redirector, a CSV export, an admin view — are protected by the *same* code
rather than a re-derivation of it. Without it, the alternative is
re-assembling the check from primitives and parsing the `Cookie` header by
hand, which is how an auxiliary route ends up subtly more permissive than the
ones it sits beside.

```ts
// app/api/review/shot/route.ts
import { requireReviewAccess } from "@r3lab/web-review/server";

export async function GET(req: Request) {
  const access = await requireReviewAccess(req, {
    access: { password: process.env.REVIEW_PASSWORD, secret: process.env.REVIEW_SECRET },
    isAdmin: async () => Boolean((await getSession())?.user?.isAdmin),
  });
  if (!access.ok) {
    return Response.json({ error: access.reason }, { status: access.status });
  }
  // …access.isAdmin tells you whether they got in as an admin.
}
```

**It is fail-closed, and the ordering is the whole point.** `getAccessConfig`
is consulted *first*, and a `null` from it ends the call at `feature_disabled`
before `isAdmin` is so much as looked at. A deployment that forgot
`REVIEW_PASSWORD` or `REVIEW_SECRET` therefore refuses every caller —
including your own administrators, who are exactly the people whose unimpeded
access would hide the misconfiguration until a reviewer (or a stranger) found
it. There is deliberately no open fallback and no admin override of the kill
switch.

**Its options object is superset-compatible with the route factory's.**
`RequireAccessOptions` is `{ access, isAdmin?, now? }`, so
`requireReviewAccess(req, reviewOptions)` type-checks when `reviewOptions` is
the *exact* value already passed to `createReviewRouteHandlers` — the `store`
and other extra properties on it are simply ignored. (`now` is an injectable
clock for deterministic tests; it defaults to `Date.now()`.)

### The verdict

```ts
type RequestAccessVerdict =
  | { ok: true; isAdmin: boolean }
  | { ok: false; reason: "feature_disabled"; status: 404 }
  | { ok: false; reason: "locked"; status: 401 };

type AccessDenialReason = Extract<RequestAccessVerdict, { ok: false }>["reason"];
```

It returns a verdict, never a `Response`: the status codes are supplied but
the body, headers and redirect behaviour stay yours to choose.
`AccessDenialReason` is there for naming the refusals in your own error
mapping — derived from the verdict rather than written out a second time, so
the two can never drift apart.

The two refusals are kept distinct because they are not the same event, and
the overlay's own client already reads them apart: `feature_disabled` means
the kill switch is off and nothing here exists for anybody (`isFeatureDisabled`
tells the client to stop asking), while `locked` means the feature is on and
this caller simply hasn't unlocked it — a correct password would change the
answer. `feature_disabled` is deliberately 404 rather than 403: a deployment
with the tool switched off must look indistinguishable from one that never
shipped it, so a probe learns nothing about whether a review surface exists
here at all.

### Already bound: `review.requireAccess`

The object `createReviewRouteHandlers` returns carries the same guard with
this factory's `access` config and `isAdmin` predicate already applied, so
there's no second copy of them to keep in sync:

```ts
// app/api/review/shot/route.ts
import { review } from "@/lib/review";

export async function GET(req: Request) {
  const access = await review.requireAccess(req);
  if (!access.ok) return Response.json({ error: access.reason }, { status: access.status });
  // …serve the screenshot.
}
```

It is identical in every respect to calling `requireReviewAccess` with that
factory's options — it *is* that call.

## `readCookieValue`

*New in 0.3.0 as a public export.* Reads one cookie's value out of a raw
`Cookie` request header:

```ts
function readCookieValue(
  header: string | null | undefined,
  name: string,
): string | undefined;
```

It exists because a Web Fetch `Request` carries no structured cookie jar on
the request side — unlike `next/server`'s `NextRequest.cookies` — and nothing
in this package may depend on a framework to get one. Every consumer
protecting an auxiliary review route hits that same wall, so the parser is
part of the public surface rather than a private detail of the route factory:
one implementation, covered by this package's own tests, instead of a
hand-rolled copy per consumer.

- It takes the header **string**, not a request object, so it fits whatever
  shape a given server exposes: `req.headers.get("cookie")` (Web Fetch —
  `null` when absent), `req.headers.cookie` (Node's `http` — `undefined` when
  absent), `c.req.header("cookie")` (Hono), and so on. All three absent-cases
  are accepted and answered `undefined`.
- **Each pair is split at its first `=` only.** Cookie values routinely
  contain `=` — base64 padding is the everyday case — and a parser that
  splits on every `=` silently truncates them. For a signed token that
  surfaces as an unexplained 401 on a cookie which was in fact perfectly
  valid: the worst kind of auth bug, because the credential still looks right
  to everyone inspecting it. This is the mistake consumers were making by
  hand, and the reason the function is exported at all.
- A `"`-quoted value is returned **with** its quotes. RFC 6265 permits them,
  but nothing in this package ever mints one, and stripping them
  unconditionally would corrupt some other cookie whose value genuinely begins
  and ends with a quote character.
- A malformed percent-escape isn't worth throwing a request over: the raw
  value comes back and the signature check rejects it.

Pair it with `accessCookieName(prefix?)` to get the name to look for.

## The rest of the server entry

`@r3lab/web-review/server` is Node-safe and framework-neutral — no React, no
Next, no DOM globals — so Express, Hono, Fastify and plain Node can use it as
readily as Next.js can. Beyond the guard above it exports the primitives the
guard composes, for anyone who needs them separately:

| Export | What it does |
|---|---|
| `getAccessConfig({ password, secret })` | The on/off switch. `null` when either is missing — translate that into a 404-equivalent. |
| `resolveAccess(token, config, isAdmin?, now?)` | Verdict for a bare token: signed cookie first, then the optional admin predicate. |
| `mintAccessToken` / `verifyAccessToken` | The HMAC token itself (`v1.<expiresAtMs>.<hmac>`). Signature is checked before the untrusted expiry. |
| `serializeAccessCookie` / `toSetCookieHeader` | Build the access cookie as a plain descriptor, then render it as a `Set-Cookie` value — no framework response object is mutated. |
| `passwordMatches(provided, expected)` | Timing-safe comparison; both sides hashed first, so there's no length leak. |
| `createUnlockRateLimiter(options?)` | An independent in-memory limiter (`windowMs`, `maxAttempts`, `maxBuckets`) — see the per-process caveat above. |
| `clientIp(getHeader)` | Best-effort client IP over a generic header getter: `x-forwarded-for`'s first entry, falling back to `x-real-ip`. |

It also re-exports the wire types, the `ReviewAdapter` contract,
`ReviewApiError` and its helpers, the row→wire serializers, the Zod
validators, PNG validation, and `VERSION`.

Full source, with the reasoning inline:
[`src/server/access.ts`](https://github.com/R3-Lab/web-review/blob/main/packages/web-review/src/server/access.ts).
