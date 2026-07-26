/**
 * Minimal in-memory attempt counter for an unlock endpoint built on this
 * package.
 *
 * LIMITATION — read before relying on this. This package ships no shared
 * rate-limit store (no Redis, no Upstash, no KV binding), so this is a
 * plain `Map` in the server process. On a serverless/edge platform that
 * means:
 *
 *   • the counter is PER PROCESS/INSTANCE — a distributed attacker hitting
 *     several warm instances gets `maxAttempts` tries on EACH;
 *   • it resets on cold start.
 *
 * It stops a naive single-client brute force, which is the realistic threat
 * for a review tool behind a long shared password on a preview deployment.
 * That caveat matters more here than in a single app, because this is a
 * published package other people depend on: if you need real protection
 * (this guards anything valuable, or you're at meaningful serverless
 * fan-out), swap in a shared store and don't rely on this module alone.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 10;
/** Bounds the map so a spray of spoofed keys (e.g. `x-forwarded-for`
 *  values) can't grow it without limit. */
const DEFAULT_MAX_BUCKETS = 5_000;

export interface RateResult {
  allowed: boolean;
  /** Seconds until the window resets. Only meaningful when `allowed` is false. */
  retryAfterSec: number;
}

export interface UnlockRateLimiterOptions {
  /** Length of the attempt-counting window, in ms. Default 10 minutes. */
  windowMs?: number;
  /** Attempts allowed per window before blocking. Default 10. */
  maxAttempts?: number;
  /** Upper bound on the number of tracked keys. Default 5000. */
  maxBuckets?: number;
}

export interface UnlockRateLimiter {
  /** Count one unlock attempt against `key` (typically the client IP). */
  consumeUnlockAttempt(key: string, now?: number): RateResult;
  /** Clear the counter for `key`, e.g. after a successful unlock. */
  clearUnlockAttempts(key: string): void;
}

/**
 * Create an independent unlock rate limiter with its own bucket map, so
 * multiple consumers (or multiple routes within one consumer) don't share
 * state unless they explicitly share the same limiter instance.
 */
export function createUnlockRateLimiter(
  options: UnlockRateLimiterOptions = {},
): UnlockRateLimiter {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;

  const buckets = new Map<string, Bucket>();

  function prune(now: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    // Still oversized after pruning live entries — drop the oldest insertions.
    if (buckets.size > maxBuckets) {
      const overflow = buckets.size - maxBuckets;
      let dropped = 0;
      for (const key of buckets.keys()) {
        buckets.delete(key);
        if (++dropped >= overflow) break;
      }
    }
  }

  return {
    consumeUnlockAttempt(key: string, now = Date.now()): RateResult {
      if (buckets.size > maxBuckets) prune(now);

      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSec: 0 };
      }
      bucket.count += 1;
      if (bucket.count > maxAttempts) {
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
    clearUnlockAttempts(key: string): void {
      buckets.delete(key);
    },
  };
}

const defaultLimiter = createUnlockRateLimiter();

/** Count one unlock attempt against `key`, using the package's default,
 *  shared limiter. Use {@link createUnlockRateLimiter} for an independent
 *  or differently-configured limiter. */
export function consumeUnlockAttempt(key: string, now = Date.now()): RateResult {
  return defaultLimiter.consumeUnlockAttempt(key, now);
}

/** Clear the default limiter's counter for `key` after a successful unlock. */
export function clearUnlockAttempts(key: string): void {
  defaultLimiter.clearUnlockAttempts(key);
}
