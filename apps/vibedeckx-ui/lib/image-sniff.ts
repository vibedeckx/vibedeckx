/**
 * Content-based detection of the image formats the model accepts as an inline
 * image block. Browsers derive `File.type` from the extension alone, so a
 * mislabeled file would reach the API with the wrong media type and be
 * rejected; the leading bytes are authoritative.
 */
export type InlineImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF = [0x47, 0x49, 0x46, 0x38]; // "GIF8" (87a / 89a)
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

/** Decode only the first 16 bytes of a base64 payload. */
function headBytes(base64: string): Uint8Array {
  const head = base64.slice(0, 24).replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const bin = atob(head.length % 4 === 0 ? head : head.slice(0, head.length - (head.length % 4)));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/**
 * Returns the model-visible image type the bytes actually are, or null when
 * they are not one of JPEG / PNG / GIF / WebP (including SVG, HEIC, TIFF, BMP
 * and non-images regardless of what `File.type` claimed).
 */
export function sniffInlineImageType(base64: string): InlineImageType | null {
  const b = headBytes(base64);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (startsWith(b, PNG)) return "image/png";
  if (startsWith(b, GIF)) return "image/gif";
  if (startsWith(b, RIFF) && startsWith(b, WEBP, 8)) return "image/webp";
  return null;
}

/**
 * Largest image sent inline, in raw bytes. Matches the API's per-image limit
 * (5 MB); anything bigger would be refused, and it would also weigh down the
 * transcript on every replay. Larger images take the file route, where the
 * agent can still open them with its own image-capable Read tool.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Raw byte length encoded by a base64 string (accounts for padding). */
export function base64ByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}
