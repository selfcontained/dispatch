/**
 * Real bytes for the file types Dispatch stores. Files are typed from their
 * contents (see `detectFileType`), so a test that uploads a "png" has to
 * upload something that is one.
 */

/** A 1x1 PNG. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

/** The start of a JPEG: enough for its signature. */
export const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
]);

/** The start of a PDF. */
export const PDF_BYTES = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1");

/** The start of an MP4: an `ftyp` box with an MP4 brand. */
export const MP4_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
  0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
]);

/** Bytes that are no type Dispatch stores. */
export const BINARY_BYTES = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x00]);
