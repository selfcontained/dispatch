/**
 * What a block's body looks like per kind, past its text: a question's
 * options, a form's fields, a review's verdict and findings, a task list, a
 * link card. Presentational — each takes the block and the one callback its
 * kind needs, and reads nothing else from the feed. Composed into posts by
 * chat-entries.tsx.
 */
import { type FormEvent, useState } from "react";
import type {
  Block,
  BlockFindingPatch,
  BlockFindingState,
  BlockFindingStatus,
  BlockFormField,
  BlockOption,
  BlockReviewFinding,
  BlockReviewSeverity,
  BlockReviewVerdict,
  BlockTaskStatus,
} from "@dispatch/shared";
import {
  Check,
  ChevronRight,
  CircleDot,
  ClipboardList,
  MessageCircleQuestion,
  ExternalLink,
  Link2,
  RotateCcw,
  XCircle,
} from "lucide-react";

import { LinkAttachment } from "@/components/app/chat/chat-attachment-views";
import { FrontTruncatedValue } from "@/components/app/agent-meta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { Collapse } from "./collapse";

/** A state patch for `PATCH …/blocks/:id/state`. */
export type BlockStatePatch = Record<string, unknown>;

/**
 * Whether a foldable block (a review, a task list) is open, kept by block
 * and place rather than in the component: the feed remounts a row whenever
 * the block behind it changes (to replay its fade-in), and resolving a
 * finding must not fold the review the reader is working through.
 */
const openedByBlock = new Map<string, boolean>();

function useOpened(
  key: string,
  fallback: boolean
): [boolean, (next: boolean) => void] {
  const [opened, setOpened] = useState<boolean>(
    () => openedByBlock.get(key) ?? fallback
  );
  const set = (next: boolean) => {
    openedByBlock.set(key, next);
    setOpened(next);
  };
  return [opened, set];
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * A question or form is an ask of the person. It wears the theme's accent
 * on a rail down its left edge and a faint wash, the same accent its
 * buttons carry, rather than a warning colour: it is an invitation, not
 * an alarm. Answered, the rail and the wash go quiet.
 */
const ASK_CARD = "mt-2 rounded-md border border-l-[3px] p-3 transition-colors";
const ASK_OPEN = "border-border/70 border-l-primary bg-primary/[0.05]";
const ASK_CLOSED = "border-border border-l-border bg-muted/30";
const ASK_HEAD =
  "mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-primary";

type AskCancellation = {
  by?: unknown;
  at?: string;
  reason?: string;
};

/** The shared contract stamps a person's cancellation onto the ask. */
function askCancellation(block: Extract<Block, { kind: "question" | "form" }>) {
  return (block.state as { cancellation?: AskCancellation } | null)
    ?.cancellation;
}

function CanceledAskStatus({
  cancellation,
}: {
  cancellation: AskCancellation;
}): JSX.Element {
  return (
    <div
      className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground"
      data-testid="chat-ask-canceled"
    >
      <XCircle className="h-3 w-3" aria-hidden="true" />
      {cancellation.reason
        ? `Canceled · ${cancellation.reason}`
        : "Canceled · no response is needed"}
    </div>
  );
}

function CancelAskButton({
  disabled,
  onCancel,
}: {
  disabled: boolean;
  onCancel?: () => void;
}): JSX.Element | null {
  if (!onCancel) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-xs"
      disabled={disabled}
      data-testid="chat-ask-cancel"
      onClick={onCancel}
    >
      Cancel
    </Button>
  );
}

export function QuestionOptions({
  block,
  answering,
  answersDisabled,
  canceling = false,
  onAnswer,
  onCancel,
}: {
  block: Extract<Block, { kind: "question" }>;
  /** This question's answer is in flight. */
  answering: boolean;
  /** Nothing can be sent right now, so neither buttons nor a typed reply. */
  answersDisabled: boolean;
  /** This ask's cancellation is in flight. */
  canceling?: boolean;
  onAnswer: (option: BlockOption) => void;
  /** Closes an ask the person no longer needs to answer. */
  onCancel?: () => void;
}): JSX.Element {
  const answer = block.state?.answer;
  const cancellation = askCancellation(block);
  const open = answer === undefined && cancellation === undefined;
  const optionsDisabled = !open || answering || answersDisabled;
  return (
    <div
      className={cn(ASK_CARD, open ? ASK_OPEN : ASK_CLOSED)}
      data-testid="chat-question-options"
    >
      {open ? (
        <div className={ASK_HEAD} data-testid="chat-needs-reply">
          <MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden="true" />
          Needs your reply
        </div>
      ) : cancellation ? (
        <CanceledAskStatus cancellation={cancellation} />
      ) : (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Check className="h-3 w-3" />
          Answered
          <span className="truncate">· {answer!.label ?? answer!.value}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {block.data.options.map((option, index) => {
          const value = option.value ?? option.label;
          const chosen = answer !== undefined && answer.value === value;
          return (
            <Button
              key={`${index}-${value}`}
              type="button"
              size="sm"
              // Open choices carry the theme's accent so the ask stands out
              // from everything else in the feed; once answered only the
              // chosen one keeps it.
              variant={chosen || open ? "primary" : "default"}
              className={cn(
                // Labels are capped server-side to button length, so a row
                // of buttons wraps between buttons, not inside one.
                "h-7 max-w-full gap-1 text-xs",
                // Phones and touch screens: a real tap target, with the label
                // allowed to wrap instead of being clipped.
                "max-sm:h-auto max-sm:min-h-11 max-sm:whitespace-normal max-sm:py-2 max-sm:text-left",
                "[@media(pointer:coarse)]:h-auto [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:whitespace-normal [@media(pointer:coarse)]:py-2 [@media(pointer:coarse)]:text-left",
                chosen && "cursor-default"
              )}
              disabled={optionsDisabled}
              aria-pressed={chosen}
              data-testid="chat-question-option"
              onClick={() => onAnswer(option)}
            >
              {chosen ? <Check className="h-3 w-3" /> : null}
              {option.label}
            </Button>
          );
        })}
      </div>
      {open && block.data.allowFreeform && !answersDisabled ? (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Or type a reply below.
        </div>
      ) : null}
      {open && onCancel ? (
        <div className="mt-2 flex justify-end">
          <CancelAskButton
            disabled={answering || canceling}
            onCancel={onCancel}
          />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

type FormValue = string | number | boolean;

function initialFormValues(
  fields: BlockFormField[]
): Record<string, FormValue> {
  const values: Record<string, FormValue> = {};
  for (const field of fields) {
    if (field.value !== undefined) values[field.id] = field.value;
    else if (field.type === "checkbox") values[field.id] = false;
    else values[field.id] = "";
  }
  return values;
}

function isBlank(value: FormValue | undefined): boolean {
  return value === undefined || value === "" || value === false;
}

function FormFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: BlockFormField;
  value: FormValue | undefined;
  disabled: boolean;
  onChange: (value: FormValue) => void;
}): JSX.Element {
  const id = `block-field-${field.id}`;
  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          id={id}
          value={String(value ?? "")}
          placeholder={field.placeholder}
          disabled={disabled}
          required={field.required}
          rows={3}
          className="min-h-[4.5rem] text-sm"
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <Input
          id={id}
          type="number"
          value={String(value ?? "")}
          placeholder={field.placeholder}
          disabled={disabled}
          required={field.required}
          className="h-8 max-w-[12rem] text-sm"
          onChange={(e) =>
            onChange(e.target.value === "" ? "" : Number(e.target.value))
          }
        />
      );
    case "select":
      return (
        <Select
          value={
            value === undefined || value === "" ? undefined : String(value)
          }
          disabled={disabled}
          onValueChange={onChange}
        >
          <SelectTrigger id={id} className="h-8 max-w-[18rem] text-sm">
            <SelectValue placeholder={field.placeholder ?? "Choose…"} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option, index) => {
              const optionValue = option.value ?? option.label;
              return (
                <SelectItem key={`${index}-${optionValue}`} value={optionValue}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      );
    case "checkbox":
      return (
        <Checkbox
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
      );
    case "text":
    default:
      return (
        <Input
          id={id}
          type="text"
          value={String(value ?? "")}
          placeholder={field.placeholder}
          disabled={disabled}
          required={field.required}
          className="h-8 text-sm"
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function formatFormValue(field: BlockFormField, value: FormValue): string {
  if (field.type === "checkbox") return value === true ? "Yes" : "No";
  if (field.type === "select") {
    const option = field.options?.find(
      (o) => (o.value ?? o.label) === String(value)
    );
    return option?.label ?? String(value);
  }
  return String(value);
}

/**
 * A form the agent asked the user to fill: its fields while open, the
 * submitted values read-only once `state.submission` is set.
 */
export function FormBlockBody({
  block,
  submitting,
  disabled,
  canceling = false,
  onSubmit,
  onCancel,
}: {
  block: Extract<Block, { kind: "form" }>;
  /** This form's submission is in flight. */
  submitting: boolean;
  /** Nothing can be sent right now. */
  disabled: boolean;
  /** This ask's cancellation is in flight. */
  canceling?: boolean;
  onSubmit: (values: Record<string, FormValue>) => void;
  /** Closes an ask the person no longer needs to answer. */
  onCancel?: () => void;
}): JSX.Element {
  const submission = block.state?.submission;
  const cancellation = askCancellation(block);
  const [values, setValues] = useState(() =>
    initialFormValues(block.data.fields)
  );
  const originalValues = initialFormValues(block.data.fields);
  const open = submission === undefined && cancellation === undefined;
  const missing = block.data.fields.some(
    (field) => field.required && isBlank(values[field.id])
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!open || missing || submitting || disabled) return;
    onSubmit(values);
  };
  return (
    <form
      className={cn(ASK_CARD, open ? ASK_OPEN : ASK_CLOSED)}
      data-testid="chat-form"
      data-open={open ? "true" : undefined}
      onSubmit={submit}
    >
      {open ? (
        <div className={ASK_HEAD} data-testid="chat-needs-reply">
          <ClipboardList className="h-3.5 w-3.5" aria-hidden="true" />
          {block.data.title ?? "Needs your input"}
        </div>
      ) : cancellation ? (
        <CanceledAskStatus cancellation={cancellation} />
      ) : (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Check className="h-3 w-3" />
          {block.data.title ? `${block.data.title} · submitted` : "Submitted"}
        </div>
      )}
      <div className="flex flex-col gap-2.5">
        {block.data.fields.map((field) => {
          const label = (
            <label
              htmlFor={`block-field-${field.id}`}
              className="text-xs font-medium text-foreground"
            >
              {field.label}
              {field.required && open ? (
                <span className="text-muted-foreground"> *</span>
              ) : null}
            </label>
          );
          if (submission) {
            const value = submission.values[field.id];
            return (
              <div
                key={field.id}
                className="flex flex-col gap-0.5"
                data-testid="chat-form-value"
                data-field-id={field.id}
              >
                {label}
                <div className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {value === undefined || value === "" ? (
                    <span className="italic">—</span>
                  ) : (
                    formatFormValue(field, value)
                  )}
                </div>
              </div>
            );
          }
          return (
            <div
              key={field.id}
              className={cn(
                "flex gap-2",
                field.type === "checkbox"
                  ? "flex-row-reverse items-center justify-end"
                  : "flex-col"
              )}
              data-testid="chat-form-field"
              data-field-id={field.id}
            >
              {label}
              <FormFieldInput
                field={field}
                value={open ? values[field.id] : originalValues[field.id]}
                disabled={!open || disabled || submitting}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, [field.id]: value }))
                }
              />
            </div>
          );
        })}
      </div>
      {open ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            type="submit"
            size="sm"
            variant="primary"
            className="h-7 text-xs"
            disabled={missing || submitting || disabled}
            data-testid="chat-form-submit"
          >
            {submitting ? "Sending…" : (block.data.submitLabel ?? "Submit")}
          </Button>
          <CancelAskButton
            disabled={submitting || canceling}
            onCancel={onCancel}
          />
        </div>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const VERDICT: Record<
  BlockReviewVerdict,
  { label: string; variant: "transitional" | "error" | "default" }
> = {
  approve: { label: "Approved", variant: "transitional" },
  request_changes: { label: "Changes requested", variant: "error" },
  comment: { label: "Comment", variant: "default" },
};

const SEVERITY_CHIP: Record<BlockReviewSeverity, string> = {
  blocker: "border-status-blocked/40 text-status-blocked",
  major: "border-status-waiting/40 text-status-waiting",
  minor: "border-border text-muted-foreground",
  nit: "border-border text-muted-foreground/80",
};

/** What a finding's record reads as: open, fixed or dismissed. */
export type FindingOutcome = "open" | "fixed" | "dismissed";

const FINDING_OUTCOME_LABEL: Record<FindingOutcome, string> = {
  open: "Open",
  fixed: "Fixed",
  dismissed: "Dismissed",
};

/** The finding a reply is about: a text or question reply may carry one. */
export function findingIdOf(block: Block): string | undefined {
  return (block.kind === "text" || block.kind === "question") && block.data
    ? block.data.findingId
    : undefined;
}

/** `state.findings[id]`, or an open record when nothing has been recorded. */
export function findingRecord(
  block: Extract<Block, { kind: "review" }>,
  findingId: string
): BlockFindingState | null {
  return block.state?.findings?.[findingId] ?? null;
}

/** `state.findings[id].status`, `open` when nothing has been recorded. */
export function findingStatus(
  block: Extract<Block, { kind: "review" }>,
  findingId: string
): BlockFindingStatus {
  return findingRecord(block, findingId)?.status ?? "open";
}

/** A resolved finding was fixed unless it says dismissed; an open one is open. */
export function findingOutcome(
  record: BlockFindingState | null | undefined
): FindingOutcome {
  if (record?.status !== "resolved") return "open";
  return record.resolution === "dismissed" ? "dismissed" : "fixed";
}

/** "5 findings · 2 open", or "No findings". */
export function findingsSummary(
  block: Extract<Block, { kind: "review" }>
): string {
  const total = block.data.findings.length;
  if (total === 0) return "No findings";
  const open = block.data.findings.filter(
    (f) => findingStatus(block, f.id) !== "resolved"
  ).length;
  return `${total} ${total === 1 ? "finding" : "findings"} · ${open} open`;
}

/**
 * First sentence of the summary's first paragraph, for the collapsed
 * header line; a heading is skipped in favour of the prose under it.
 */
export function summarySentence(summary: string): string {
  const line =
    summary
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((l) => l.replace(/^[>*\-\s]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  const match = /^(.+?[.!?])(\s|$)/.exec(line);
  return (match ? match[1]! : line).replace(/[*_`]/g, "");
}

/** The wire shape of a finding change: a word, or a record with a note. */
export function findingStatePatch(
  findingId: string,
  patch: BlockFindingPatch
): BlockStatePatch {
  return { findings: { [findingId]: patch } };
}

/** Colours for a finding's status pill. */
const FINDING_STATUS_PILL: Record<FindingOutcome, string> = {
  open: "border-status-waiting/50 bg-status-waiting/10 text-status-waiting",
  fixed: "border-status-done/40 bg-status-done/10 text-status-done",
  dismissed: "border-border bg-muted/60 text-muted-foreground",
};

/** The card's left edge and header tint follow the verdict. */
const VERDICT_EDGE: Record<BlockReviewVerdict, string> = {
  approve: "border-l-status-done",
  request_changes: "border-l-status-blocked",
  comment: "border-l-border",
};

/** A finding's outcome as a small pill: Open, Fixed or Dismissed. */
export function FindingStatusPill({
  record,
  className,
}: {
  record: BlockFindingState | null | undefined;
  className?: string;
}): JSX.Element {
  const outcome = findingOutcome(record);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide",
        FINDING_STATUS_PILL[outcome],
        className
      )}
      data-testid="chat-review-finding-status"
      data-status={record?.status ?? "open"}
      data-outcome={outcome}
    >
      {FINDING_OUTCOME_LABEL[outcome]}
    </span>
  );
}

/** A finding's severity as a small chip. */
export function SeverityChip({
  severity,
}: {
  severity: BlockReviewSeverity;
}): JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
        SEVERITY_CHIP[severity] ?? SEVERITY_CHIP.minor
      )}
      data-testid="chat-review-severity"
    >
      {severity}
    </span>
  );
}

/** "apps/web/src/x.tsx:33", as a link into the Changes tab when one is offered. */
function FindingPath({
  finding,
  onOpenPath,
}: {
  finding: BlockReviewFinding;
  onOpenPath?: (path: string, line: number | null) => void;
}): JSX.Element | null {
  if (!finding.path) return null;
  const label = `${finding.path}${finding.line !== undefined ? `:${finding.line}` : ""}`;
  // Clipped from the front, as file names are everywhere else: the name
  // and line at the end are what tell one finding from the next.
  const value = (
    <FrontTruncatedValue
      value={label}
      mono
      className="text-[11px] text-muted-foreground"
    />
  );
  return onOpenPath ? (
    <button
      type="button"
      className="min-w-0 max-w-full flex-1 text-left underline-offset-2 hover:text-foreground hover:underline"
      title="Open in Changes"
      data-testid="chat-review-finding-path"
      onClick={() => onOpenPath(finding.path!, finding.line ?? null)}
    >
      {value}
    </button>
  ) : (
    <span
      className="min-w-0 max-w-full flex-1"
      data-testid="chat-review-finding-path"
    >
      {value}
    </span>
  );
}

/**
 * A button that asks for a note before it acts: Dismiss wants a reason,
 * Reopen may carry one. The note goes into the finding's record.
 */
function NotedAction({
  label,
  icon,
  prompt,
  required,
  disabled,
  variant,
  testId,
  onConfirm,
}: {
  label: string;
  icon: JSX.Element;
  prompt: string;
  required: boolean;
  disabled: boolean;
  variant: "default" | "success";
  testId: string;
  onConfirm: (note: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = note.trim();
    if (required && !trimmed) return;
    onConfirm(trimmed);
    setNote("");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={variant}
          className="h-9 flex-1 gap-1.5 sm:flex-none"
          disabled={disabled}
          data-testid={testId}
        >
          {icon}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <label
            className="text-xs font-medium text-foreground"
            htmlFor={`${testId}-note`}
          >
            {prompt}
          </label>
          <Textarea
            id={`${testId}-note`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            autoFocus
            placeholder={required ? "Why?" : "Optional"}
            data-testid={`${testId}-note`}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant={variant}
              disabled={required && !note.trim()}
              data-testid={`${testId}-confirm`}
            >
              {label}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The status controls for one finding, sized for a thumb: Fixed and
 * Dismiss (with a reason) while it is open, Reopen once it is not.
 */
export function FindingActions({
  record,
  disabled,
  onPatch,
}: {
  record: BlockFindingState | null | undefined;
  disabled: boolean;
  onPatch: (patch: BlockFindingPatch) => void;
}): JSX.Element {
  const status = record?.status ?? "open";
  return (
    <div
      className="flex flex-wrap gap-2"
      data-testid="chat-review-finding-actions"
    >
      {status === "open" ? (
        <>
          <Button
            type="button"
            variant="success"
            className="h-9 flex-1 gap-1.5 sm:flex-none"
            disabled={disabled}
            data-testid="chat-review-resolve"
            onClick={() => onPatch("fixed")}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            Fixed
          </Button>
          <NotedAction
            label="Dismiss"
            icon={<XCircle className="h-4 w-4" aria-hidden="true" />}
            prompt="Why set this finding aside?"
            required
            disabled={disabled}
            variant="default"
            testId="chat-review-dismiss"
            onConfirm={(note) =>
              onPatch({ status: "resolved", resolution: "dismissed", note })
            }
          />
        </>
      ) : (
        <NotedAction
          label="Reopen"
          icon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}
          prompt="What still needs doing?"
          required={false}
          disabled={disabled}
          variant="default"
          testId="chat-review-reopen"
          onConfirm={(note) =>
            onPatch(note ? { status: "open", note } : "open")
          }
        />
      )}
    </div>
  );
}

/** "Fixed by Codex · 2m ago", with the note under it when there is one. */
function FindingRecordLine({
  record,
  authorName,
}: {
  record: BlockFindingState;
  authorName?: (by: BlockFindingState["by"]) => string;
}): JSX.Element {
  const outcome = findingOutcome(record);
  const verb =
    outcome === "open"
      ? "Reopened"
      : outcome === "fixed"
        ? "Fixed"
        : "Dismissed";
  const who = authorName
    ? authorName(record.by)
    : record.by.kind === "user"
      ? "you"
      : record.by.agentId;
  return (
    <div
      className="flex flex-col gap-0.5 text-xs text-muted-foreground"
      data-testid="chat-review-finding-record"
    >
      <span>
        {verb} by {who}
        {record.at ? ` · ${formatRelativeTime(record.at)}` : ""}
      </span>
      {record.note ? (
        <div data-testid="chat-review-finding-note">
          <Markdown className="text-xs text-foreground/80">
            {record.note}
          </Markdown>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One finding in full: severity, place, status, the requested change, and
 * the status controls. The finding panel's subject; the discussion under
 * it is the panel's.
 */
export function FindingDetail({
  block,
  finding,
  disabled,
  onSetState,
  onOpenPath,
  authorName,
}: {
  block: Extract<Block, { kind: "review" }>;
  finding: BlockReviewFinding;
  disabled: boolean;
  onSetState?: (patch: BlockStatePatch) => void;
  onOpenPath?: (path: string, line: number | null) => void;
  /** Names whoever last changed the finding. */
  authorName?: (by: BlockFindingState["by"]) => string;
}): JSX.Element {
  const record = findingRecord(block, finding.id);
  // A record with no note and an "open" status is the reviewer's initial
  // stamp, not a change worth a line.
  const changed =
    record && (record.status !== "open" || record.note !== undefined);
  return (
    <div className="flex flex-col gap-3" data-testid="chat-finding-detail">
      <div className="flex flex-wrap items-center gap-2">
        <FindingStatusPill record={record} />
        <SeverityChip severity={finding.severity} />
        <FindingPath finding={finding} onOpenPath={onOpenPath} />
      </div>
      <h3 className="text-[15px] font-semibold leading-snug text-foreground">
        {finding.title}
      </h3>
      {changed ? (
        <FindingRecordLine record={record} authorName={authorName} />
      ) : null}
      {onSetState ? (
        <FindingActions
          record={record}
          disabled={disabled}
          onPatch={(patch) => onSetState(findingStatePatch(finding.id, patch))}
        />
      ) : null}
      <Markdown className="text-sm text-foreground/90">{finding.body}</Markdown>
    </div>
  );
}

/**
 * A review as a card of its own, unlike a text post: a verdict-coloured
 * edge, a header that names the verdict and counts, the summary, and one
 * compact row per finding (status, severity, title, place, comments) that
 * opens the finding's panel. The full text and the status controls live
 * there. Open by default while findings are open; the fold animates.
 */
export function ReviewBlockBody({
  block,
  onOpenFinding,
  onOpenPath,
  highlightFindingId = null,
  defaultExpanded = false,
  commentCounts,
  unreadCounts,
  compact = false,
  onOpen,
}: {
  block: Extract<Block, { kind: "review" }>;
  /** State changes are unavailable (no callback, or nothing can be sent). */
  disabled: boolean;
  onSetState?: (patch: BlockStatePatch) => void;
  /** Opens the finding's panel. */
  onOpenFinding?: (findingId: string) => void;
  /** Opens the Changes tab on a finding's file. */
  onOpenPath?: (path: string, line: number | null) => void;
  highlightFindingId?: string | null;
  defaultExpanded?: boolean;
  /** Replies about each finding, by finding id. */
  commentCounts?: Readonly<Record<string, number>>;
  /** Agent replies about each finding the person has not seen, by finding id. */
  unreadCounts?: Readonly<Record<string, number>>;
  /**
   * The stream's card: the verdict, the counts and the summary's first
   * sentence, and a click opens the review in the drawer, where the
   * findings and their details are. Off in the drawer, which shows it all.
   */
  compact?: boolean;
  /** Opens the review's page; the compact card's click. */
  onOpen?: () => void;
}): JSX.Element {
  const [expandedState, setExpanded] = useOpened(
    `review:${block.id}`,
    defaultExpanded
  );
  const expanded = compact ? false : expandedState;
  const verdict = VERDICT[block.data.verdict] ?? VERDICT.comment;
  const findings = block.data.findings;
  const open = findings.filter(
    (finding) => findingStatus(block, finding.id) === "open"
  ).length;
  const unread = Object.values(unreadCounts ?? {}).reduce(
    (sum: number, n: number) => sum + n,
    0
  );
  return (
    <div
      className={cn(
        "mt-1 overflow-hidden rounded-md border border-border/60 border-l-[3px] bg-card/60",
        VERDICT_EDGE[block.data.verdict] ?? VERDICT_EDGE.comment
      )}
      data-testid="chat-review-block"
      data-expanded={expanded ? "true" : undefined}
      data-compact={compact ? "true" : undefined}
    >
      <button
        type="button"
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left hover:bg-muted/30"
        aria-expanded={compact ? undefined : expanded}
        aria-label={compact ? "Open the review" : undefined}
        data-testid="chat-review-header"
        onClick={() => (compact ? onOpen?.() : setExpanded(!expanded))}
      >
        {compact ? null : (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-300",
              expanded && "rotate-90"
            )}
            aria-hidden="true"
          />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Review
        </span>
        <Badge
          variant={verdict.variant}
          data-testid="chat-review-verdict"
          data-verdict={block.data.verdict}
        >
          {verdict.label}
        </Badge>
        <span
          className="ml-auto shrink-0 text-[11px] text-muted-foreground"
          data-testid="chat-review-counts"
        >
          {findingsSummary(block)}
        </span>
        {unread > 0 ? (
          <span
            className="shrink-0 rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground"
            data-testid="chat-review-unread"
            aria-label={`${unread} new ${unread === 1 ? "comment" : "comments"}`}
          >
            {unread}
          </span>
        ) : null}
        {compact ? (
          <>
            {block.data.summary ? (
              <span
                className="basis-full truncate text-[13px] text-foreground/85"
                data-testid="chat-review-summary-line"
              >
                {summarySentence(block.data.summary)}
              </span>
            ) : null}
            <ChevronRight
              className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
              aria-hidden="true"
            />
          </>
        ) : null}
      </button>
      {compact ? null : (
        <Collapse open={expanded} data-testid="chat-review-details">
          <div className="border-t border-border/40 px-3 pb-2 pt-2">
            {block.data.summary ? (
              <Markdown className="mb-2 text-[13px] text-foreground/90 prose-p:my-0.5">
                {block.data.summary}
              </Markdown>
            ) : null}
            {findings.length > 0 ? (
              <ol
                className="-mx-1 flex flex-col divide-y divide-border/40 border-t border-border/40"
                data-testid="chat-review-findings"
              >
                {findings.map((finding) => {
                  const record = findingRecord(block, finding.id);
                  const status = record?.status ?? "open";
                  const comments = commentCounts?.[finding.id] ?? 0;
                  const fresh = unreadCounts?.[finding.id] ?? 0;
                  const highlighted = highlightFindingId === finding.id;
                  const row = (
                    <>
                      <FindingStatusPill record={record} />
                      <SeverityChip severity={finding.severity} />
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-sm font-medium text-foreground",
                          status === "resolved" &&
                            "text-muted-foreground line-through"
                        )}
                        title={finding.title}
                      >
                        {finding.title}
                      </span>
                      {comments > 0 ? (
                        <span
                          className={cn(
                            "shrink-0 text-[11px]",
                            fresh > 0
                              ? "font-semibold text-foreground"
                              : "text-muted-foreground"
                          )}
                          data-testid="chat-review-finding-comments"
                        >
                          {comments} {comments === 1 ? "comment" : "comments"}
                        </span>
                      ) : null}
                      {fresh > 0 ? (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full bg-primary"
                          data-testid="chat-review-finding-unread"
                          aria-label={`${fresh} new`}
                        />
                      ) : null}
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
                        aria-hidden="true"
                      />
                    </>
                  );
                  return (
                    <li
                      key={finding.id}
                      className={cn(
                        "px-1",
                        highlighted && "rounded-md bg-primary/[0.08]"
                      )}
                      data-testid="chat-review-finding"
                      data-finding-id={finding.id}
                      data-status={status}
                      data-outcome={findingOutcome(record)}
                      data-highlighted={highlighted ? "true" : undefined}
                    >
                      {onOpenFinding ? (
                        <button
                          type="button"
                          className="flex w-full min-w-0 items-center gap-2 py-2 text-left hover:bg-muted/30"
                          data-testid="chat-review-finding-link"
                          aria-label={`${finding.title}, ${FINDING_OUTCOME_LABEL[findingOutcome(record)]}, open finding`}
                          onClick={() => onOpenFinding(finding.id)}
                        >
                          {row}
                        </button>
                      ) : (
                        <div className="flex w-full min-w-0 items-center gap-2 py-2">
                          {row}
                        </div>
                      )}
                      <div className="pb-1.5 pl-1">
                        <FindingPath
                          finding={finding}
                          onOpenPath={onOpenPath}
                        />
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {open === 0 && findings.length > 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Every finding is resolved.
              </p>
            ) : null}
          </div>
        </Collapse>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** `state.items[id]`, `todo` when nothing has been recorded. */
export function taskStatus(
  block: Extract<Block, { kind: "tasks" }>,
  itemId: string
): BlockTaskStatus {
  return block.state?.items?.[itemId] ?? "todo";
}

/**
 * A checklist the agent keeps: `done` items are ticked, the one it is on
 * (`now`) carries a marker, the rest are still to do. The agent moves
 * items with `update`; people read it and do not edit it. Once every item
 * is done the list folds to its count line and opens on click.
 */
export function TasksBlockBody({
  block,
}: {
  block: Extract<Block, { kind: "tasks" }>;
}): JSX.Element {
  const items = block.data.items;
  const done = items.filter((i) => taskStatus(block, i.id) === "done").length;
  const allDone = items.length > 0 && done === items.length;
  // Opens by default until every item is done; a reader's own fold or
  // unfold wins over that, and survives the row's remount on an update.
  const [expanded, setOpened] = useOpened(`tasks:${block.id}`, !allDone);
  return (
    <div
      className="mt-1"
      data-testid="chat-tasks-block"
      data-expanded={expanded ? "true" : undefined}
    >
      {items.length > 0 ? (
        <button
          type="button"
          className="flex items-center gap-1 text-[11px] text-muted-foreground"
          aria-expanded={expanded}
          data-testid="chat-tasks-header"
          onClick={() => setOpened(!expanded)}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 transition-transform",
              expanded && "rotate-90"
            )}
            aria-hidden="true"
          />
          {done}/{items.length} done
        </button>
      ) : null}
      {expanded ? (
        <ul className="mt-1 flex flex-col gap-1">
          {items.map((item) => {
            const status = taskStatus(block, item.id);
            const checked = status === "done";
            return (
              <li
                key={item.id}
                className="flex items-start gap-2"
                data-testid="chat-task"
                data-task-id={item.id}
                data-status={status}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border",
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : status === "now"
                        ? "border-status-working text-status-working"
                        : "border-border"
                  )}
                  role="img"
                  aria-label={
                    checked
                      ? "Done"
                      : status === "now"
                        ? "In progress"
                        : "To do"
                  }
                >
                  {checked ? (
                    <Check className="h-3 w-3" aria-hidden="true" />
                  ) : status === "now" ? (
                    <CircleDot className="h-3 w-3" aria-hidden="true" />
                  ) : null}
                </span>
                <span
                  className={cn(
                    "min-w-0 text-sm",
                    checked
                      ? "text-muted-foreground line-through"
                      : "text-foreground"
                  )}
                >
                  {item.text}
                </span>
                {status === "now" ? (
                  <span
                    className="rounded-full border border-status-working/40 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-status-working"
                    data-testid="chat-task-now"
                  >
                    now
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function isPullRequestUrl(url: string): boolean {
  return /\/pull\/\d+/.test(url) || /\/merge_requests\/\d+/.test(url);
}

/** A link block: the same card an attached link gets. A PR is a link. */
export function LinkBlockBody({
  block,
}: {
  block: Extract<Block, { kind: "link" }>;
}): JSX.Element {
  const { url, title } = block.data;
  return (
    <div className="mt-1" data-testid="chat-link-block">
      <LinkAttachment
        href={url}
        title={title}
        icon={
          isPullRequestUrl(url) ? (
            <Link2 className="h-3.5 w-3.5" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )
        }
        testId="chat-link-block-card"
      />
    </div>
  );
}
