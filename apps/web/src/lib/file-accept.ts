/**
 * Accepted upload extensions, as an `accept=""`-ready comma list.
 *
 * Re-exported from the shared server module so the list always matches what
 * the upload endpoint's isSupportedFile() validation accepts. The shared module
 * is dependency-free (no node or browser globals), so any consumer —
 * including ones loaded in a non-jsdom test environment — can use the list
 * without pulling in browser-only code (e.g. file-upload → api →
 * energy-metrics, which touches `document` at module load).
 */
export {
  FILE_UPLOAD_ACCEPT as STARTUP_FILE_ACCEPT,
  isImageFile,
} from "../../../server/src/shared/file-types";
