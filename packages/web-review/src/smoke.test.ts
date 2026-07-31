import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("smoke", () => {
  it("exposes a package version", () => {
    // Shape only, deliberately. This is a smoke test: it proves the main
    // entry loads and hands back a version at all. The VALUE is pinned to
    // package.json's `version` field — for this entry and the four other
    // public ones — in ./version.test.ts, which is where a stale constant
    // is meant to fail. Repeating a literal here is what let all five
    // entries sit on "0.1.0" through a 0.2.0 release.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
