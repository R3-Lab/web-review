/**
 * PNG signature + IHDR dimension validation, ported from a screenshot-upload
 * route's inline checks.
 *
 * Accepts `Uint8Array` or `ArrayBuffer` rather than Node's `Buffer`, so this
 * works on edge runtimes that don't have the Node `Buffer` global.
 */

const PNG_MAGIC: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngSize {
  width: number;
  height: number;
}

function toBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

/**
 * A PNG's first chunk is always IHDR, at a fixed offset:
 *   0..7   signature
 *   8..11  chunk length      12..15  "IHDR"
 *   16..19 width (u32 BE)    20..23  height (u32 BE)
 * So the first 24 bytes carry the dimensions — no decode, no dependency.
 * Returns `null` when the buffer is too short or the chunk isn't IHDR,
 * which means the file is malformed however well-formed its signature
 * looked.
 */
export function readPngSize(input: Uint8Array | ArrayBuffer): PngSize | null {
  const bytes = toBytes(input);
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // "IHDR" in ASCII: 0x49 0x48 0x44 0x52.
  const isIhdr =
    view.getUint8(12) === 0x49 &&
    view.getUint8(13) === 0x48 &&
    view.getUint8(14) === 0x44 &&
    view.getUint8(15) === 0x52;
  if (!isIhdr) return null;
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

export type PngValidationResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: "not_a_png" | "too_large" | "too_small" };

export interface ValidatePngOptions {
  /** Reject buffers larger than this, in bytes. Omit to skip the check. */
  maxBytes?: number;
  /**
   * Smallest width/height worth keeping, in pixels. A 1×1 or otherwise
   * degenerate capture is worse than none at all — it hangs off a thread
   * looking like evidence.
   *
   * Dimensions, not bytes: a byte floor is a bad proxy in both directions —
   * a legitimately sparse capture compresses tiny, while a large
   * mostly-white capture can also be small. The exact answer is in the IHDR
   * header, which is what {@link readPngSize} reads. Omit to skip the check.
   */
  minDimension?: number;
}

/**
 * Validate a candidate screenshot upload: real PNG signature, well-formed
 * IHDR, within the configured size bounds. `input.type`/`Content-Type` (set
 * by the client) is never trusted for the "is this actually a PNG"
 * question — this checks the actual bytes.
 */
export function validatePng(
  input: Uint8Array | ArrayBuffer,
  options: ValidatePngOptions = {},
): PngValidationResult {
  const bytes = toBytes(input);

  if (options.maxBytes != null && bytes.length > options.maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  if (!hasPngSignature(bytes)) {
    return { ok: false, reason: "not_a_png" };
  }

  // A file can carry a valid signature and still be truncated past it, so
  // the header read is guarded rather than assumed.
  const size = readPngSize(bytes);
  if (!size) return { ok: false, reason: "not_a_png" };

  const minDimension = options.minDimension ?? 0;
  if (size.width < minDimension || size.height < minDimension) {
    return { ok: false, reason: "too_small" };
  }

  return { ok: true, width: size.width, height: size.height };
}
