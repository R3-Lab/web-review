import { describe, expect, it } from "vitest";
import { clearUnlockAttempts, consumeUnlockAttempt, createUnlockRateLimiter } from "./rate-limit";

describe("createUnlockRateLimiter", () => {
  it("allows up to maxAttempts, then blocks", () => {
    const limiter = createUnlockRateLimiter({ windowMs: 60_000, maxAttempts: 3 });
    const now = 0;
    expect(limiter.consumeUnlockAttempt("k", now).allowed).toBe(true); // 1
    expect(limiter.consumeUnlockAttempt("k", now).allowed).toBe(true); // 2
    expect(limiter.consumeUnlockAttempt("k", now).allowed).toBe(true); // 3
    expect(limiter.consumeUnlockAttempt("k", now).allowed).toBe(false); // 4 — over the limit
  });

  it("reports a sane retryAfterSec once blocked", () => {
    const limiter = createUnlockRateLimiter({ windowMs: 60_000, maxAttempts: 1 });
    const now = 10_000;
    limiter.consumeUnlockAttempt("k", now); // 1, allowed
    const blocked = limiter.consumeUnlockAttempt("k", now); // 2, blocked
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60); // full window remaining from `now`
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("resets the counter once the window elapses", () => {
    const limiter = createUnlockRateLimiter({ windowMs: 1_000, maxAttempts: 1 });
    limiter.consumeUnlockAttempt("k", 0); // 1, allowed
    expect(limiter.consumeUnlockAttempt("k", 500).allowed).toBe(false); // still in window
    expect(limiter.consumeUnlockAttempt("k", 1_500).allowed).toBe(true); // window has reset
  });

  it("tracks separate keys independently", () => {
    const limiter = createUnlockRateLimiter({ windowMs: 60_000, maxAttempts: 1 });
    expect(limiter.consumeUnlockAttempt("a", 0).allowed).toBe(true);
    expect(limiter.consumeUnlockAttempt("b", 0).allowed).toBe(true);
    expect(limiter.consumeUnlockAttempt("a", 0).allowed).toBe(false);
    expect(limiter.consumeUnlockAttempt("b", 0).allowed).toBe(false);
  });

  it("clearUnlockAttempts resets a key immediately, within the same window", () => {
    const limiter = createUnlockRateLimiter({ windowMs: 60_000, maxAttempts: 1 });
    limiter.consumeUnlockAttempt("k", 0); // 1, allowed
    expect(limiter.consumeUnlockAttempt("k", 0).allowed).toBe(false); // 2, blocked
    limiter.clearUnlockAttempts("k");
    expect(limiter.consumeUnlockAttempt("k", 0).allowed).toBe(true); // fresh again
  });

  it("enforces the maxBuckets bound by evicting old entries", () => {
    const limiter = createUnlockRateLimiter({ windowMs: 60_000, maxAttempts: 10, maxBuckets: 3 });
    // Fill past the bound with distinct keys.
    for (let i = 0; i < 5; i++) {
      limiter.consumeUnlockAttempt(`key-${i}`, 0);
    }
    // The earliest keys must have been evicted, so they start a fresh
    // window rather than being blocked by a stale bucket.
    const result = limiter.consumeUnlockAttempt("key-0", 0);
    expect(result.allowed).toBe(true);
  });
});

describe("default consumeUnlockAttempt / clearUnlockAttempts", () => {
  it("share state across calls via the package's default limiter", () => {
    const key = `default-limiter-test-${Math.random()}`;
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      expect(consumeUnlockAttempt(key, now).allowed).toBe(true);
    }
    expect(consumeUnlockAttempt(key, now).allowed).toBe(false);
    clearUnlockAttempts(key);
    expect(consumeUnlockAttempt(key, now).allowed).toBe(true);
  });
});
