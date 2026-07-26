import { describe, expect, it } from "vitest";
import { readPngSize, validatePng } from "./png";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Build the minimal bytes readPngSize/validatePng inspect: signature +
 *  chunk-length placeholder + "IHDR" + width/height (u32 BE). No IDAT/IEND —
 *  neither function reads past the IHDR header. */
function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set(PNG_SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false); // IHDR chunk data length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

describe("readPngSize", () => {
  it("parses width/height from a valid IHDR header", () => {
    expect(readPngSize(makePng(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", () => {
    const bytes = makePng(100, 50);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    expect(readPngSize(buffer)).toEqual({ width: 100, height: 50 });
  });

  it("returns null for a buffer shorter than 24 bytes", () => {
    expect(readPngSize(makePng(800, 600).slice(0, 16))).toBeNull();
    expect(readPngSize(new Uint8Array(0))).toBeNull();
  });

  it("returns null when the first chunk isn't IHDR", () => {
    const bytes = makePng(800, 600);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT" instead of "IHDR"
    expect(readPngSize(bytes)).toBeNull();
  });

  it("returns null for non-PNG bytes", () => {
    expect(readPngSize(new Uint8Array(24).fill(0))).toBeNull();
  });
});

describe("validatePng", () => {
  it("accepts a valid PNG within bounds", () => {
    const result = validatePng(makePng(800, 600), { maxBytes: 5_000_000, minDimension: 200 });
    expect(result).toEqual({ ok: true, width: 800, height: 600 });
  });

  it("rejects bytes without a PNG signature", () => {
    const notPng = new Uint8Array(24).fill(0x41); // all "A"
    expect(validatePng(notPng)).toEqual({ ok: false, reason: "not_a_png" });
  });

  it("rejects a truncated buffer (valid signature, cut off before IHDR)", () => {
    const truncated = makePng(800, 600).slice(0, 10);
    expect(validatePng(truncated)).toEqual({ ok: false, reason: "not_a_png" });
  });

  it("rejects dimensions under the configured minimum", () => {
    const result = validatePng(makePng(100, 100), { minDimension: 200 });
    expect(result).toEqual({ ok: false, reason: "too_small" });
  });

  it("accepts dimensions exactly at the minimum", () => {
    const result = validatePng(makePng(200, 200), { minDimension: 200 });
    expect(result).toEqual({ ok: true, width: 200, height: 200 });
  });

  it("rejects a buffer over the configured max bytes", () => {
    const big = new Uint8Array(1000);
    big.set(makePng(800, 600), 0);
    const result = validatePng(big, { maxBytes: 500 });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("only enforces bounds that are actually configured", () => {
    // No maxBytes/minDimension given — a valid PNG of any size passes.
    expect(validatePng(makePng(1, 1))).toEqual({ ok: true, width: 1, height: 1 });
  });

  it("rejects when width is below minimum but height is not (and vice versa)", () => {
    expect(validatePng(makePng(50, 800), { minDimension: 200 })).toEqual({
      ok: false,
      reason: "too_small",
    });
    expect(validatePng(makePng(800, 50), { minDimension: 200 })).toEqual({
      ok: false,
      reason: "too_small",
    });
  });
});
