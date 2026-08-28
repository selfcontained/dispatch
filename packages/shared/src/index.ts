/**
 * Contracts both the API server and the web client have to agree on.
 *
 * Anything here is imported by `apps/server` and `apps/web` alike, so it must
 * stay dependency-free and runtime-free: no `node:` imports, no browser APIs.
 * Types only for now — a value would land in the browser bundle and in the
 * compiled server binary at once.
 */
export type {
  DiffFile,
  DiffFileStatus,
  DiffResponse,
  DiffStats,
  DiffTotals,
  FileDiffResponse,
} from "./diff-types.js";
export type {
  ActionRef,
  ActionsBlock,
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
  TableBlock,
  TableColumn,
  TableRow,
  TextBlock,
  Tone,
} from "./surface-types.js";
export type {
  InjectionHoldState,
  SharedUiEvent,
  TerminalCopyMode,
  TerminalUiState,
} from "./ui-event-types.js";
