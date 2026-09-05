/**
 * Contracts both the API server and the web client have to agree on.
 *
 * Anything here is imported by `apps/server` and `apps/web` alike, so it must
 * stay dependency-free and runtime-free: no `node:` imports, no browser APIs.
 * Almost all of it is types; a value exported here lands in the browser bundle
 * and in the compiled server binary at once, so keep those to plain constants
 * that both sides genuinely have to agree on.
 */
export {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  DEFAULT_ENABLED_AGENT_TYPES,
} from "./agent-types.js";
export type { AgentType, CliAgentType } from "./agent-types.js";
export type {
  AgentGitContext,
  AgentLatestEvent,
  AgentLatestEventType,
  AgentPin,
  AgentRecord,
  AgentRole,
  AgentStatus,
  ArchivePhase,
  SetupPhase,
  WorktreeCleanupMode,
} from "./agent-record.js";
export { VALID_PIN_SHORTCUT_VARIANTS, VALID_PIN_TYPES } from "./pin-types.js";
export type { PinShortcutVariant, PinType } from "./pin-types.js";
export {
  CHAT_ATTACHMENTS_MAX,
  CHAT_MESSAGE_MAX_CHARS,
  CHAT_QUESTION_OPTIONS_MAX,
} from "./chat-types.js";
export type {
  ChatActivityEntry,
  ChatActivityStatus,
  ChatAgentMessageEntry,
  ChatAssistantEntry,
  ChatAnswer,
  ChatAnswerRequest,
  ChatAnswerResponse,
  ChatAttachment,
  ChatAuthorKind,
  ChatChangedEvent,
  ChatFeedEntry,
  ChatFeedResponse,
  ChatMediaEntry,
  ChatMessage,
  ChatMessageEntry,
  ChatMessageKind,
  ChatMessageOrigin,
  ChatQuestion,
  ChatQuestionOption,
  ChatReviewEntry,
  ChatSendRequest,
  ChatSendResponse,
  ChatStatusEntry,
  ChatUnreadSummary,
  ChatUserAttachmentInput,
} from "./chat-types.js";
export type {
  HarnessPrompt,
  HarnessQueuedPrompt,
  HarnessQuestion,
  HarnessStep,
  HarnessStepStatus,
  HarnessTurn,
  HarnessTurnsResponse,
  HarnessSkill,
  HarnessSkillsResponse,
  HarnessConfigChoice,
  HarnessConfigGroup,
  HarnessConfigOption,
  HarnessConfigResponse,
  HarnessConfigUpdateRequest,
} from "./harness-types.js";
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
