/** Runtime-free wire contract for agent-authored surfaces (schema v2). */

export type Scalar = string | number | boolean | null;

export type SurfaceIcon =
  | "layout"
  | "list"
  | "table"
  | "checklist"
  | "message"
  | "flag"
  | "clock"
  | "sparkles"
  | "form";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

type BlockBase = {
  id: string;
  title?: string;
  description?: string;
};

export type TextBlock = BlockBase & {
  type: "text";
  text: string;
  /** Renders the block as a callout in the tone's color. Reserve for the
   * sentence that changes a decision; plain prose omits it. */
  tone?: Tone;
};

/** A compact action scoped to one list item or table row. */
export type SurfaceItemAction = Pick<ActionRef, "id" | "label" | "intent">;

export type SurfaceListItem = {
  id: string;
  text: string;
  /** Freeform visible state; use `tone` to express its semantic color. */
  status?: string;
  tone?: Tone;
  /** Completion independent of the freeform status, used by check-style lists. */
  checked?: boolean;
  detail?: string;
  /** Safe external link shown as a secondary affordance. */
  url?: string;
  /** A small subheading that groups adjacent items in this list. */
  group?: string;
  /** One action renders inline on the item's title row; more collapse into a
   * per-item overflow menu. Placement and weight are renderer-owned. */
  actions?: SurfaceItemAction[];
};

export type ListBlock = BlockBase & {
  type: "list";
  style?: "bullet" | "number" | "check";
  /** Controls an expandable long-list tail without introducing a new block. */
  collapse?: { after: number; label?: string };
  /** Shows the total item count alongside the list heading. */
  showItemCount?: boolean;
  items: SurfaceListItem[];
};

export type TableColumn = {
  id: string;
  label: string;
  format?: "text" | "number" | "date" | "badge" | "code" | "url";
  badgeVariants?: Record<string, Tone>;
  align?: "left" | "right";
  /**
   * `secondary` always renders behind a per-row disclosure — the sidebar
   * rail is a fixed width, not a responsive breakpoint. At most 3 columns
   * may be primary; reserve `secondary` for verbose diagnostics, and keep
   * a decision-critical value (a risk/status badge, anything the user
   * compares at a glance) in the `primary` default.
   */
  priority?: "primary" | "secondary";
};

export type TableRow = {
  id: string;
  cells: Record<string, Scalar>;
  /** One action renders inline at the row's end; more collapse into a
   * per-row overflow menu. */
  actions?: SurfaceItemAction[];
};

export type TableBlock = BlockBase & {
  type: "table";
  /** Shows the total row count alongside the table heading. */
  showItemCount?: boolean;
  columns: TableColumn[];
  rows: TableRow[];
};

export type StatusBlock = BlockBase & {
  type: "status";
  status: string;
  tone?: Tone;
  detail?: string;
  timestamp?: string;
};

export type ProgressBlock = BlockBase & {
  type: "progress";
  value: number;
  max: number;
  label?: string;
  detail?: string;
  tone?: Exclude<Tone, "danger">;
};

export type ActionRef = {
  id: string;
  label: string;
  intent: string;
  /** Semantic weight only — the renderer owns visual treatment. One primary
   * per surface; destructive is reserved for irreversible verbs and renders
   * de-emphasized (in the overflow menu when other actions exist). */
  style?: "default" | "primary" | "destructive";
  icon?: SurfaceIcon;
  confirm?: { title: string; description?: string };
  disabled?: boolean;
  disabledReason?: string;
};

/** A form's submit control. Always rendered as the form's primary action, so
 * it carries no style knob. */
export type SurfaceSubmitAction = Omit<ActionRef, "style">;

export type FormFieldOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

type FormFieldBase = {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
};

export type FormField =
  | (FormFieldBase & {
      type: "text" | "textarea";
      placeholder?: string;
      defaultValue?: string;
      minLength?: number;
      maxLength?: number;
    })
  | (FormFieldBase & {
      type: "select";
      multiple?: boolean;
      options: FormFieldOption[];
      defaultValue?: string | string[];
    })
  | (FormFieldBase & {
      type: "radio";
      options: FormFieldOption[];
      defaultValue?: string;
    })
  | (FormFieldBase & { type: "checkbox"; defaultValue?: boolean })
  | (FormFieldBase & {
      type: "number";
      min?: number;
      max?: number;
      step?: number;
      defaultValue?: number;
    });

export type FormBlock = BlockBase & {
  type: "form";
  fields: FormField[];
  submit: SurfaceSubmitAction;
  resetLabel?: string;
  submitMode?: "once" | "repeatable";
};

/** A titled group of blocks, optionally rendered with a collapsed body. */
export type SurfaceSectionBlock = BlockBase & {
  type: "section";
  /** Required so a collapsed section always retains a visible header. */
  title: string;
  blocks: SurfaceBlock[];
  /** The section's footer slot: verbs that act on this group. Rendered
   * right-aligned and compact at the group's bottom edge. */
  actions?: ActionRef[];
  collapse?: { initiallyCollapsed?: boolean };
};

export type SurfaceBlock =
  | TextBlock
  | ListBlock
  | TableBlock
  | StatusBlock
  | ProgressBlock
  | FormBlock
  | SurfaceSectionBlock;

/** The always-first summary strip: the surface's headline state. */
export type SurfaceHeader = {
  status?: StatusBlock;
  progress?: ProgressBlock;
};

/** The surface's verbs. Rendered at the document's bottom edge as a compact
 * split button with an overflow menu; interactions address it with the
 * reserved block id "footer". */
export type SurfaceFooter = {
  actions: ActionRef[];
};

export type SurfaceDocumentInput = {
  title: string;
  icon?: SurfaceIcon;
  header?: SurfaceHeader;
  blocks: SurfaceBlock[];
  footer?: SurfaceFooter;
};

export type SurfaceLifecycle = "active" | "frozen";

export type SurfaceInteractionStatus =
  | "queued"
  | "notified"
  | "claimed"
  | "completed"
  | "rejected"
  | "cancelled"
  | "orphaned";

export type SurfaceInteractionRequest =
  | {
      idempotencyKey: string;
      kind: "action";
      /** A block id, a section id, or the reserved id "footer" for the
       * document's footer actions. */
      blockId: string;
      actionId: string;
      /** Required for actions scoped to a list item or table row. */
      itemId?: string;
      baseRevision: number;
    }
  | {
      idempotencyKey: string;
      kind: "form_submit";
      blockId: string;
      actionId: string;
      values: Record<string, Scalar | string[]>;
      baseRevision: number;
    };

/** Latest durable interaction state for one block action. */
export type SurfaceInteractionSummary = {
  id: string;
  tabRevision: number;
  blockId: string;
  actionId: string;
  itemId?: string;
  kind: "action" | "form_submit";
  status: SurfaceInteractionStatus;
  outcomeMessage?: string;
  createdAt: string;
  claimedAt?: string;
  resolvedAt?: string;
};

export type Surface = {
  /** Stored documents carry the version they were authored under; the
   * sidebar renders only the current version and shows a re-create notice
   * for older ones. */
  schemaVersion: number;
  id: string;
  ownerAgentId: string;
  title: string;
  icon?: SurfaceIcon;
  revision: number;
  lifecycle: SurfaceLifecycle;
  sortOrder: number;
  header?: SurfaceHeader;
  blocks: SurfaceBlock[];
  footer?: SurfaceFooter;
  createdAt: string;
  updatedAt: string;
  unresolvedInteractionCount: number;
  latestInteractions: SurfaceInteractionSummary[];
};

export const SURFACE_SCHEMA_VERSION = 2;

/** Reserved interaction address for document footer actions. */
export const SURFACE_FOOTER_BLOCK_ID = "footer";

export type SurfaceInteractionRecord = {
  schemaVersion: number;
  id: string;
  agentId: string;
  tabId: string;
  tabRevision: number;
  kind: "action" | "form_submit";
  intent: string;
  payload: Record<string, unknown>;
  definitionSnapshot: Record<string, unknown>;
  status: SurfaceInteractionStatus;
  outcomeMessage?: string;
  createdAt: string;
  claimedAt?: string;
  resolvedAt?: string;
};

/** The interaction fields consumed by the sidebar after a submission. */
export type SurfaceInteraction = Pick<
  SurfaceInteractionRecord,
  "id" | "status" | "outcomeMessage"
>;

export type SurfaceInteractionResponse = {
  interaction: SurfaceInteraction;
  delivery: "queued" | "notified";
  duplicate: boolean;
};

export type SurfaceChangedEvent = {
  type: "surface.changed";
  agentId: string;
  surfaceId: string;
  change: "created" | "updated" | "deleted" | "reordered" | "interaction";
};
