/**
 * Extensions the file picker offers, as an `accept=""`-ready comma list.
 *
 * A hint for the picker only: the server types every upload from its bytes
 * (`detectFileType`) and decides what it accepts. Re-exported from the shared
 * server module, which is dependency-free (no node or browser globals), so any consumer —
 * including ones loaded in a non-jsdom test environment — can use the list
 * without pulling in browser-only code (e.g. file-upload → api →
 * energy-metrics, which touches `document` at module load).
 */
export {
  FILE_UPLOAD_ACCEPT as STARTUP_FILE_ACCEPT,
  isImageFile,
} from "../../../server/src/shared/file-types";
