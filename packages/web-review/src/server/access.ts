/// <reference types="node" />

/**
 * Framework-neutral access control for a review-route factory built on this
 * package.
 *
 * Reviewers on a preview deployment are stakeholders without app accounts —
 * requiring a login would kill adoption — so the gate is a shared password
 * that mints a signed, httpOnly cookie. Consumers may additionally let their
 * own admins in without the shared password, via an optional predicate a
 * route factory supplies (see {@link resolveAccess}).
 *
 * KILL SWITCH: the feature is off unless BOTH a password and a signing
 * secret are configured. {@link getAccessConfig} returns `null` when either
 * is missing — a route factory must translate that into "not found" for
 * every review route. There is deliberately NO "open" fallback, so a
 * consumer who forgets to set the password env var exposes nothing.
 *
 * This module ported the reference's HMAC scheme, generalized only where
 * the reference leaned on `next/server` or Better Auth:
 *  - No `NextRequest`/`NextResponse`. Every function here takes plain values
 *    (a cookie string, a header getter) and returns plain data (a verdict
 *    object, a cookie descriptor) — see {@link resolveAccess} and
 *    {@link serializeAccessCookie}.
 *  - No session-store dependency. The reference let admins in via a Better
 *    Auth session lookup; here that becomes a consumer-supplied
 *    {@link AdminPredicate} that a route factory passes in.
 * The crypto itself — HMAC-SHA256 signing, domain separation, password
 * binding, timing-safe comparisons — is unchanged from the reference.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Default prefix for the access cookie's name — see {@link accessCookieName}. */
export const DEFAULT_ACCESS_COOKIE_PREFIX = "r3wr";

/** How long an unlock lasts. Baked into the signature, so a reviewer cannot
 *  extend it by editing the cookie's own expiry. */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Token version prefix — bump to invalidate every outstanding cookie. */
const TOKEN_VERSION = "v1";

/** Fixed signing-domain string, distinct from any other secret usage a
 *  consumer's app might make of the same signing secret (domain separation
 *  — see {@link signingKey}). */
const SIGNING_DOMAIN = "r3lab.web-review.access";

const hasProcessEnv =
  typeof process !== "undefined" && typeof process.env === "object" && process.env !== null;

/** `true` in a Node/production-style environment, `false` everywhere else
 *  (including runtimes with no `process` global, e.g. some edge runtimes).
 *  Used only as {@link serializeAccessCookie}'s default for the `Secure`
 *  attribute — callers may always override it explicitly. */
const IS_PROD_DEFAULT = hasProcessEnv && process.env.NODE_ENV === "production";

export interface AccessConfig {
  password: string;
  secret: string;
}

/**
 * The feature's on/off switch. Returns `null` when the tool is disabled,
 * which a route factory must translate into a 404-equivalent for every
 * review route.
 *
 * Takes the password/secret as plain arguments rather than reading
 * `process.env` itself, so it works the same whether a consumer's env
 * lookup is `process.env.X` (Node/Next), a Cloudflare Worker's `env.X`, or
 * anything else — the route factory owns that lookup and passes the result
 * in.
 */
export function getAccessConfig(input: {
  password: string | undefined;
  secret: string | undefined;
}): AccessConfig | null {
  const password = input.password ?? "";
  const secret = input.secret ?? "";
  if (!password) return null;
  // Password set but nothing to sign with — fail closed rather than fall
  // back to an unsigned (forgeable) cookie. A route factory that wants to
  // log this misconfiguration can do so itself: `password` truthy and this
  // function returning `null` is exactly that condition.
  if (!secret) return null;
  return { password, secret };
}

function sha256(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

/**
 * Derive the HMAC key from the configured secret. Two properties matter:
 *
 *  1. Domain separation — the access cookie is never signed with the raw
 *     secret; the key is derived with a fixed, package-specific domain
 *     string, so a signing oracle here can't forge other session data a
 *     consumer signs with the same secret.
 *  2. Password binding — the current password's digest is folded in, so
 *     rotating the password invalidates every outstanding cookie.
 */
function signingKey(config: AccessConfig): Buffer {
  return createHmac("sha256", config.secret)
    .update(`${SIGNING_DOMAIN}.${TOKEN_VERSION}:`)
    .update(sha256(config.password))
    .digest();
}

function sign(payload: string, config: AccessConfig): string {
  return createHmac("sha256", signingKey(config)).update(payload).digest("base64url");
}

/** Mint a cookie value of the form `v1.<expiresAtMs>.<hmac>`. */
export function mintAccessToken(config: AccessConfig, now = Date.now()): string {
  const expiresAt = now + TOKEN_TTL_MS;
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  return `${payload}.${sign(payload, config)}`;
}

/**
 * Verify a cookie value. Signature is checked before the (untrusted)
 * expiry. `now` is an injectable clock for deterministic tests rather than
 * a hidden `Date.now()` call.
 */
export function verifyAccessToken(
  token: string | undefined,
  config: AccessConfig,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, expiresRaw, providedSig] = parts;
  if (version !== TOKEN_VERSION) return false;
  if (expiresRaw === undefined || !/^\d{1,15}$/.test(expiresRaw)) return false;
  if (providedSig === undefined) return false;

  const expected = Buffer.from(sign(`${version}.${expiresRaw}`, config), "base64url");
  const provided = Buffer.from(providedSig, "base64url");
  // Length is not secret; timingSafeEqual throws on a mismatch, so guard first.
  if (provided.length !== expected.length) return false;
  if (!timingSafeEqual(provided, expected)) return false;

  return Number(expiresRaw) > now;
}

/**
 * Timing-safe password comparison. Both sides are hashed first so the
 * compare is over two fixed-length 32-byte digests — no length leak, and
 * `timingSafeEqual` never throws on unequal input lengths.
 */
export function passwordMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

/** The name of the access cookie for a given prefix (default: package default). */
export function accessCookieName(prefix: string = DEFAULT_ACCESS_COOKIE_PREFIX): string {
  return `${prefix}.access`;
}

export interface AccessCookieAttributes {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  /** Seconds, matching `Set-Cookie`'s `Max-Age`. */
  maxAge: number;
}

export interface AccessCookieDescriptor {
  name: string;
  value: string;
  attributes: AccessCookieAttributes;
}

/**
 * Build the access cookie a route factory sets after a successful unlock.
 * Returns a plain descriptor (name/value/attributes) rather than mutating a
 * framework response object, so it works the same whether the caller is
 * Next.js, Hono, Express, or plain Node.
 */
export function serializeAccessCookie(
  config: AccessConfig,
  opts: { cookiePrefix?: string; secure?: boolean; now?: number } = {},
): AccessCookieDescriptor {
  return {
    name: accessCookieName(opts.cookiePrefix),
    value: mintAccessToken(config, opts.now),
    attributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: opts.secure ?? IS_PROD_DEFAULT,
      path: "/",
      maxAge: Math.floor(TOKEN_TTL_MS / 1000),
    },
  };
}

/** Render a cookie descriptor as a `Set-Cookie` header value. */
export function toSetCookieHeader(descriptor: AccessCookieDescriptor): string {
  const { name, value, attributes } = descriptor;
  const parts = [`${name}=${value}`, `Max-Age=${attributes.maxAge}`, `Path=${attributes.path}`, "SameSite=Lax"];
  if (attributes.httpOnly) parts.push("HttpOnly");
  if (attributes.secure) parts.push("Secure");
  return parts.join("; ");
}

export type AdminPredicate = () => boolean | Promise<boolean>;

export type AccessVerdict = { ok: true; isAdmin: boolean } | { ok: false };

/**
 * The gate a route factory runs before every protected operation except the
 * unlock endpoint itself.
 *
 * Order matters: the signed cookie is checked before the optional admin
 * predicate, so the common (reviewer) path costs zero database round-trips.
 * A predicate that throws is treated as "not admin" rather than propagating
 * — an admin-lookup failure must not turn an ordinary "locked" response into
 * a 500; a route factory that wants to log the failure can wrap its own
 * predicate to do so.
 */
export async function resolveAccess(
  token: string | undefined,
  config: AccessConfig,
  isAdmin?: AdminPredicate,
  now = Date.now(),
): Promise<AccessVerdict> {
  if (verifyAccessToken(token, config, now)) {
    return { ok: true, isAdmin: false };
  }

  if (isAdmin) {
    try {
      if (await isAdmin()) return { ok: true, isAdmin: true };
    } catch {
      // Swallow — see doc comment above.
    }
  }

  return { ok: false };
}

/**
 * Best-effort client IP for the unlock rate limiter, over a generic header
 * getter (so this works with any framework's request object). Prefers
 * `x-forwarded-for`'s first entry, falling back to `x-real-ip`.
 */
export function clientIp(getHeader: (name: string) => string | null | undefined): string {
  const fwd = getHeader("x-forwarded-for");
  if (fwd) {
    const [first] = fwd.split(",");
    return (first ?? fwd).trim();
  }
  return getHeader("x-real-ip")?.trim() || "unknown";
}
