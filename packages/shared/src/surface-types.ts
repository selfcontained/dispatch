/** Runtime-free wire contract for agent-authored surfaces. */

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

export type TextBlock = BlockBase & { type: "text"; text: string };

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
  action?: SurfaceItemAction;
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
  align?: "left" | "center" | "right";
  /**
   * `secondary` always renders behind a per-row disclosure — the sidebar
   * rail is a fixed width, not a responsive breakpoint. Reserve it for
   * verbose diagnostics; a decision-critical value (a risk/status badge,
   * anything the user needs to compare at a glance) belongs in the
   * `primary` default so it's visible without an extra click.
   */
  priority?: "primary" | "secondary";
};

export type TableRow = {
  id: string;
  cells: Record<string, Scalar>;
  action?: SurfaceItemAction;
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
  style?: "default" | "primary" | "destructive";
  icon?: SurfaceIcon;
  confirm?: { title: string; description?: string };
  disabled?: boolean;
  disabledReason?: string;
};

export type ActionsBlock = BlockBase & {
  type: "actions";
  layout?: "auto" | "stack";
  actions: ActionRef[];
};

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
  submit: ActionRef;
  resetLabel?: string;
  submitMode?: "once" | "repeatable";
};

export type SurfaceBlock =
  | TextBlock
  | ListBlock
  | TableBlock
  | StatusBlock
  | ProgressBlock
  | ActionsBlock
  | FormBlock;

export type SurfaceDocumentInput = {
  title: string;
  icon?: SurfaceIcon;
  blocks: SurfaceBlock[];
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
  schemaVersion: 1;
  id: string;
  ownerAgentId: string;
  title: string;
  icon?: SurfaceIcon;
  revision: number;
  lifecycle: SurfaceLifecycle;
  sortOrder: number;
  blocks: SurfaceBlock[];
  createdAt: string;
  updatedAt: string;
  unresolvedInteractionCount: number;
  latestInteractions: SurfaceInteractionSummary[];
};

export type SurfaceInteractionRecord = {
  schemaVersion: 1;
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
