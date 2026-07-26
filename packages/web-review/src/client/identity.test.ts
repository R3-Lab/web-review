/**
 * Reviewer identity unit tests (vitest + jsdom). Covers:
 *  (a) `ensureIdentity` mints and persists an identity;
 *  (b) `getIdentity` returns the SAME identity on re-read;
 *  (c) `storagePrefix` isolates identities — different prefixes never
 *      collide in the same origin's localStorage;
 *  (d) survives localStorage throwing (Safari private mode) — degrades to
 *      an in-memory identity / `null`, never throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewerIdentity } from "../core/types";
import { ensureIdentity, getIdentity, identityStorageKey } from "./identity";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ensureIdentity", () => {
  it("mints a fresh identity and persists it", () => {
    const identity = ensureIdentity("r3wr", "Ada Lovelace");
    expect(identity.name).toBe("Ada Lovelace");
    expect(identity.id).toMatch(/^[0-9a-f-]{36}$/i);

    const raw = window.localStorage.getItem(identityStorageKey("r3wr"));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(identity);
  });

  it("reuses the persisted id on a later call, updating only the name", () => {
    const first = ensureIdentity("r3wr", "Ada");
    const second = ensureIdentity("r3wr", "Ada Lovelace");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Ada Lovelace");
  });

  it("falls back to the existing name when called with a blank name", () => {
    const first = ensureIdentity("r3wr", "Ada");
    const second = ensureIdentity("r3wr", "   ");
    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Ada");
  });
});

describe("getIdentity", () => {
  it("returns null when nothing has been persisted yet", () => {
    expect(getIdentity("r3wr")).toBeNull();
  });

  it("returns the same identity ensureIdentity minted", () => {
    const minted = ensureIdentity("r3wr", "Grace Hopper");
    expect(getIdentity("r3wr")).toEqual(minted);
  });

  it("returns null for malformed JSON under the key", () => {
    window.localStorage.setItem(identityStorageKey("r3wr"), "{not json");
    expect(getIdentity("r3wr")).toBeNull();
  });
});

describe("storagePrefix isolation", () => {
  it("keeps identities under different prefixes independent", () => {
    const a = ensureIdentity("appA", "Reviewer A");
    const b = ensureIdentity("appB", "Reviewer B");

    expect(a.id).not.toBe(b.id);
    expect(getIdentity("appA")).toEqual(a);
    expect(getIdentity("appB")).toEqual(b);
    expect(identityStorageKey("appA")).not.toBe(identityStorageKey("appB"));
  });
});

describe("localStorage unavailable (private mode)", () => {
  it("getIdentity degrades to null instead of throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => getIdentity("r3wr")).not.toThrow();
    expect(getIdentity("r3wr")).toBeNull();
  });

  it("ensureIdentity still returns an in-memory identity instead of throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    let identity: ReviewerIdentity | undefined;
    expect(() => {
      identity = ensureIdentity("r3wr", "Reviewer");
    }).not.toThrow();
    expect(identity?.name).toBe("Reviewer");
    expect(typeof identity?.id).toBe("string");
  });
});
