/**
 * Contracts both the API server and the web client have to agree on.
 *
 * Anything here is imported by `apps/server` and `apps/web` alike, so it must
 * stay dependency-free and runtime-free: no `node:` imports, no browser APIs.
 * Almost all of it is types; a value exported here lands in the browser bundle
 * and in the compiled server binary at once, so keep those to plain constants
 * that both sides genuinely have to agree on.
 */
export { DIFF_IMAGE_MAX_BYTES } from "./diff-types.js";
export type {
  DiffFile,
  DiffFileStatus,
  DiffImageInfo,
  DiffResponse,
  DiffStats,
  DiffTotals,
  FileDiffResponse,
} from "./diff-types.js";
export type {
  ActionRef,
  FormBlock,
  FormField,
  FormFieldOption,
  ListBlock,
  ProgressBlock,
  Scalar,
  StatusBlock,
  Surface,
  SurfaceBlock,
  SurfaceChangedEvent,
  SurfaceDocumentInput,
  SurfaceFooter,
  SurfaceHeader,
  SurfaceIcon,
  SurfaceInteraction,
  SurfaceInteractionRecord,
  SurfaceInteractionRequest,
  SurfaceInteractionResponse,
  SurfaceInteractionStatus,
  SurfaceInteractionSummary,
  SurfaceItemAction,
  SurfaceLifecycle,
  SurfaceListItem,
  SurfaceSectionBlock,
  SurfaceSubmitAction,
  TableBlock,
  TableColumn,
  TableRow,
  TextBlock,
  Tone,
} from "./surface-types.js";
export {
  SURFACE_FOOTER_BLOCK_ID,
  SURFACE_SCHEMA_VERSION,
} from "./surface-types.js";
export type {
  InjectionHoldState,
  SharedUiEvent,
  TerminalCopyMode,
  TerminalUiState,
} from "./ui-event-types.js";
