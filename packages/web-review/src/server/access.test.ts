import { describe, expect, it } from "vitest";
import {
  accessCookieName,
  clientIp,
  getAccessConfig,
  mintAccessToken,
  passwordMatches,
  resolveAccess,
  serializeAccessCookie,
  toSetCookieHeader,
  verifyAccessToken,
} from "./access";
import type { AccessConfig } from "./access";

const config: AccessConfig = { password: "hunter2", secret: "signing-secret" };

describe("getAccessConfig — kill switch / fail closed", () => {
  it("returns a config when both password and secret are set", () => {
    expect(getAccessConfig({ password: "p", secret: "s" })).toEqual({ password: "p", secret: "s" });
  });

  it("returns null when password is missing", () => {
    expect(getAccessConfig({ password: undefined, secret: "s" })).toBeNull();
    expect(getAccessConfig({ password: "", secret: "s" })).toBeNull();
  });

  it("returns null when secret is missing even though password is set (fail closed, not unsigned)", () => {
    expect(getAccessConfig({ password: "p", secret: undefined })).toBeNull();
    expect(getAccessConfig({ password: "p", secret: "" })).toBeNull();
  });

  it("returns null when both are missing", () => {
    expect(getAccessConfig({ password: undefined, secret: undefined })).toBeNull();
  });
});

describe("mintAccessToken / verifyAccessToken — round trip", () => {
  it("verifies a freshly minted token", () => {
    const token = mintAccessToken(config, 1_000);
    expect(verifyAccessToken(token, config, 1_000)).toBe(true);
  });

  it("verifies right up until expiry, but not after", () => {
    const now = 1_000;
    const token = mintAccessToken(config, now);
    const ttlMs = 7 * 24 * 60 * 60 * 1000;
    expect(verifyAccessToken(token, config, now + ttlMs - 1)).toBe(true);
    expect(verifyAccessToken(token, config, now + ttlMs + 1)).toBe(false);
  });

  it("rejects an undefined token", () => {
    expect(verifyAccessToken(undefined, config)).toBe(false);
  });

  it("rejects a malformed token (wrong number of segments)", () => {
    expect(verifyAccessToken("v1.123", config)).toBe(false);
    expect(verifyAccessToken("v1.123.abc.extra", config)).toBe(false);
    expect(verifyAccessToken("garbage", config)).toBe(false);
  });

  it("rejects a token with a non-numeric expiry", () => {
    expect(verifyAccessToken("v1.notanumber.abc", config)).toBe(false);
  });
});

describe("verifyAccessToken — tamper resistance", () => {
  it("rejects a tampered signature", () => {
    const token = mintAccessToken(config, 1_000);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -1)}X`;
    expect(verifyAccessToken(tampered, config, 1_000)).toBe(false);
  });

  it("rejects a tampered (extended) expiry even if the signature format still parses", () => {
    const token = mintAccessToken(config, 1_000);
    const parts = token.split(".");
    // Extend the expiry without re-signing — the signature no longer matches.
    const tampered = `${parts[0]}.999999999999999.${parts[2]}`;
    expect(verifyAccessToken(tampered, config, 1_000)).toBe(false);
  });

  it("rejects an expired token", () => {
    const now = 1_000;
    const token = mintAccessToken(config, now);
    const ttlMs = 7 * 24 * 60 * 60 * 1000;
    expect(verifyAccessToken(token, config, now + ttlMs + 1)).toBe(false);
  });

  it("rejects a wrong-version token", () => {
    const token = mintAccessToken(config, 1_000);
    const parts = token.split(".");
    const tampered = `v2.${parts[1]}.${parts[2]}`;
    expect(verifyAccessToken(tampered, config, 1_000)).toBe(false);
  });
});

describe("verifyAccessToken — password rotation invalidates cookies", () => {
  it("a cookie minted under password A fails to verify after rotating to password B", () => {
    const configA: AccessConfig = { password: "password-a", secret: "shared-secret" };
    const configB: AccessConfig = { password: "password-b", secret: "shared-secret" };
    const token = mintAccessToken(configA, 1_000);

    expect(verifyAccessToken(token, configA, 1_000)).toBe(true);
    expect(verifyAccessToken(token, configB, 1_000)).toBe(false);
  });
});

describe("passwordMatches", () => {
  it("is true for matching passwords", () => {
    expect(passwordMatches("hunter2", "hunter2")).toBe(true);
  });

  it("is false for a mismatched password", () => {
    expect(passwordMatches("hunter2", "hunter3")).toBe(false);
  });

  it("is false for passwords of different lengths (no length-mismatch throw)", () => {
    expect(passwordMatches("short", "a-much-longer-password")).toBe(false);
  });
});

describe("accessCookieName", () => {
  it("uses the default package prefix", () => {
    expect(accessCookieName()).toBe("r3wr.access");
  });

  it("honors a custom prefix", () => {
    expect(accessCookieName("myapp")).toBe("myapp.access");
  });
});

describe("serializeAccessCookie / toSetCookieHeader", () => {
  it("mints a verifiable token as the cookie value", () => {
    const descriptor = serializeAccessCookie(config, { now: 1_000 });
    expect(verifyAccessToken(descriptor.value, config, 1_000)).toBe(true);
  });

  it("sets secure httpOnly lax attributes with the expected maxAge", () => {
    const descriptor = serializeAccessCookie(config, { secure: true });
    expect(descriptor.attributes.httpOnly).toBe(true);
    expect(descriptor.attributes.sameSite).toBe("lax");
    expect(descriptor.attributes.secure).toBe(true);
    expect(descriptor.attributes.path).toBe("/");
    expect(descriptor.attributes.maxAge).toBe(7 * 24 * 60 * 60);
  });

  it("renders a Set-Cookie header string", () => {
    const descriptor = serializeAccessCookie(config, { secure: true, cookiePrefix: "myapp" });
    const header = toSetCookieHeader(descriptor);
    expect(header).toContain("myapp.access=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
  });

  it("omits Secure when explicitly disabled", () => {
    const descriptor = serializeAccessCookie(config, { secure: false });
    const header = toSetCookieHeader(descriptor);
    expect(header).not.toContain("Secure");
  });
});

describe("resolveAccess — ordering and admin fallback", () => {
  it("succeeds via a valid cookie without ever calling the admin predicate", async () => {
    const token = mintAccessToken(config, 1_000);
    let called = false;
    const isAdmin = () => {
      called = true;
      return true;
    };
    const verdict = await resolveAccess(token, config, isAdmin, 1_000);
    expect(verdict).toEqual({ ok: true, isAdmin: false });
    expect(called).toBe(false);
  });

  it("falls back to the admin predicate when the cookie is absent", async () => {
    const verdict = await resolveAccess(undefined, config, () => true, 1_000);
    expect(verdict).toEqual({ ok: true, isAdmin: true });
  });

  it("falls back to the admin predicate when the cookie is invalid", async () => {
    const verdict = await resolveAccess("garbage", config, () => Promise.resolve(true), 1_000);
    expect(verdict).toEqual({ ok: true, isAdmin: true });
  });

  it("locks out when there is no cookie and no admin predicate", async () => {
    const verdict = await resolveAccess(undefined, config, undefined, 1_000);
    expect(verdict).toEqual({ ok: false });
  });

  it("locks out when the admin predicate returns false", async () => {
    const verdict = await resolveAccess(undefined, config, () => false, 1_000);
    expect(verdict).toEqual({ ok: false });
  });

  it("treats a throwing admin predicate as 'not admin' rather than propagating", async () => {
    const isAdmin = () => {
      throw new Error("db down");
    };
    await expect(resolveAccess(undefined, config, isAdmin, 1_000)).resolves.toEqual({ ok: false });
  });
});

describe("clientIp", () => {
  it("uses the first entry of x-forwarded-for", () => {
    const headers: Record<string, string> = { "x-forwarded-for": "1.2.3.4, 5.6.7.8" };
    expect(clientIp((name) => headers[name])).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const headers: Record<string, string> = { "x-real-ip": "9.9.9.9" };
    expect(clientIp((name) => headers[name])).toBe("9.9.9.9");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    expect(clientIp(() => undefined)).toBe("unknown");
    expect(clientIp(() => null)).toBe("unknown");
  });

  it("trims whitespace around the forwarded entry", () => {
    const headers: Record<string, string> = { "x-forwarded-for": "  1.2.3.4  , 5.6.7.8" };
    expect(clientIp((name) => headers[name])).toBe("1.2.3.4");
  });
});
