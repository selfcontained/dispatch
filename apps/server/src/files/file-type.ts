/**
 * What a file is, read from its bytes.
 *
 * Every path that stores a file row calls this once, and the answer is kept
 * on the row as `files.mime_type`. Nothing downstream works a type out again:
 * the files API, block attachments and the route that serves the bytes all
 * read the stored value, and `fileMedia` turns it into what a reader switches
 * on.
 *
 * The bytes decide, not the name and not whatever an uploader declared. A
 * browser's declared type is usually its own guess from the extension, and an
 * agent uploading by path declares nothing at all. Binary formats announce
 * themselves in their first bytes; a file that is none of them is text only if
 * it decodes as UTF-8 with no NUL bytes, and anything else is refused.
 *
 * Text is the one place the name still counts: bytes can say "text" but not
 * "Markdown" or "TypeScript", so the extension picks the subtype.
 *
 * A name that promises a binary format the bytes do not deliver — a `.png`
 * that is really a JPEG, or text — is refused rather than stored under
 * either type: the name is what readers see and what a download is saved as,
 * so it must not lie about the contents.
 */
import { mimeType as mimeTypeFromName } from "../shared/files.js";

export type DetectedFileType =
  | { ok: true; mimeType: string }
  | { ok: false; error: string };

const UNSUPPORTED =
  "Unsupported file type. Use images (png/jpg/gif/webp), video (mp4), documents (pdf), or text files (txt/md/json/yaml/ts/py/etc).";

/** ISO base media brands that are MP4 video, not HEIC, AVIF or QuickTime. */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "dash",
]);

function startsWith(buffer: Buffer, bytes: readonly number[], at = 0): boolean {
  if (buffer.length < at + bytes.length) return false;
  return bytes.every((byte, i) => buffer[at + i] === byte);
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.length < end ? "" : buffer.toString("latin1", start, end);
}

/** The binary type the bytes carry a signature for, or null. */
function sniffBinary(buffer: Buffer): string | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const gif = ascii(buffer, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (ascii(buffer, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(buffer, 4, 8) === "ftyp" && MP4_BRANDS.has(ascii(buffer, 8, 12))) {
    return "video/mp4";
  }
  return null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function isText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try {
    utf8.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** Whether a type from the name is text, so only the subtype comes from it. */
function isTextType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  );
}

export function detectFileType(
  buffer: Buffer,
  fileName: string
): DetectedFileType {
  const named = mimeTypeFromName(fileName);
  const namedBinary =
    named !== "application/octet-stream" && !isTextType(named);
  const sniffed = sniffBinary(buffer);
  if (sniffed) {
    if (namedBinary && named !== sniffed) {
      return {
        ok: false,
        error: `"${fileName}" is named as ${named} but its contents are ${sniffed}.`,
      };
    }
    return { ok: true, mimeType: sniffed };
  }
  if (namedBinary) {
    return {
      ok: false,
      error: `"${fileName}" is named as ${named} but its contents are not.`,
    };
  }
  if (!isText(buffer)) return { ok: false, error: UNSUPPORTED };
  return { ok: true, mimeType: isTextType(named) ? named : "text/plain" };
}
