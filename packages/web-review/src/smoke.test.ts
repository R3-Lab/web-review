import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("smoke", () => {
  it("exposes a package version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
