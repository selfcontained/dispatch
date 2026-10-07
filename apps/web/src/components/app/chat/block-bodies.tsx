/**
 * What a block's body looks like per kind, past its text: a question's
 * options, a form's fields, a review's status and findings, a task list, a
 * link card. Presentational — each takes the block and the one callback its
 * kind needs, and reads nothing else from the feed. Composed into posts by
 * chat-entries.tsx.
 */
import { type FormEvent, useId, useRef, useState, useEffect } from "react";
import type {
  Block,
  ChatUserAttachmentInput,
  BlockFindingData,
  BlockFindingPatch,
  BlockFindingState,
  BlockFormField,
  BlockOption,
  BlockReviewSeverity,
  BlockReviewStatus,
  BlockTaskStatus,
} from "@dispatch/shared";
import {
  CHAT_ATTACHMENTS_MAX,
  reviewFindings,
  reviewStatus,
} from "@dispatch/shared";
import {
  Check,
  Paperclip,
  ChevronRight,
  CircleDot,
  ChevronLeft,
  ExternalLink,
  Link2,
  RotateCcw,
  XCircle,
} from "lucide-react";

import { useAtom } from "jotai";
import { questionDraftAtomFamily, EMPTY_QUESTION_DRAFT } from "@/lib/store";
import { uploadAgentFile, STARTUP_FILE_ACCEPT } from "@/lib/file-upload";
import { getClipboardFilesFromEvent } from "@/components/app/create-agent-dialog-clipboard";
import { ContextChip } from "@/components/app/context-picker-items";
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

/** Compact choices share one action strip with freeform and cancellation. */
const ASK_CHOICE =
  "h-auto min-h-7 max-w-full rounded-full border border-primary/40 bg-primary/20 text-primary px-2 py-1 text-[11px] leading-4 whitespace-normal break-words shadow-none backdrop-blur-none hover:border-primary/60 hover:bg-primary/30 hover:text-primary";
const ASK_ACTION = "h-7 rounded-full px-2 text-[11px] leading-4 shadow-none";

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
  label = "Cancel",
}: {
  label?: string;
  disabled: boolean;
  onCancel?: () => void;
}): JSX.Element | null {
  if (!onCancel) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={ASK_ACTION}
      disabled={disabled}
      data-testid="chat-ask-cancel"
      onClick={onCancel}
    >
      {label}
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
  onAnswer: (
    option: BlockOption,
    attachments?: ChatUserAttachmentInput[]
  ) => void;
  /** Closes an ask the person no longer needs to answer. */
  onCancel?: () => void;
}): JSX.Element {
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useAtom(
    questionDraftAtomFamily(`${block.streamId}:${block.id}`)
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const choiceRef = useRef<HTMLButtonElement>(null);
  const answer = block.state?.answer;
  const cancellation = askCancellation(block);
  const open = answer === undefined && cancellation === undefined;
  const optionsDisabled =
    !open || answering || answersDisabled || canceling || uploading;
  useEffect(() => {
    if (!open && !answering && !canceling && (draft.text || draft.files.length))
      setDraft(EMPTY_QUESTION_DRAFT);
  }, [open, answering, canceling, draft, setDraft]);

  const attachFiles = async (files: File[]) => {
    if (
      optionsDisabled ||
      uploadingRef.current ||
      !files.length ||
      block.author.kind !== "agent"
    )
      return;
    if (draft.files.length + files.length > CHAT_ATTACHMENTS_MAX) {
      setUploadError(`Up to ${CHAT_ATTACHMENTS_MAX} attachments per answer.`);
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of files) {
        const uploaded = await uploadAgentFile(block.author.agentId, file, {
          source: "user",
          inject: false,
        });
        setDraft((current) => ({
          ...current,
          files: [...current.files, { id: uploaded.id, name: file.name }],
        }));
      }
    } catch (error) {
      setUploadError(
        error instanceof Error
          ? error.message
          : "Upload failed. Please try attaching the file again."
      );
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };
  const backToChoices = () => {
    setWriting(false);
    requestAnimationFrame(() => choiceRef.current?.focus());
  };
  return (
    <div className="mt-2" data-testid="chat-question-options">
      {!open ? (
        cancellation ? (
          <CanceledAskStatus cancellation={cancellation} />
        ) : (
          <div
            className="flex items-start gap-1.5 text-xs"
            data-testid="chat-question-answer"
            role="status"
          >
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
            <span className="shrink-0 text-muted-foreground">Answered ·</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">
              {block.data.options.find(
                (option) => (option.value ?? option.label) === answer!.value
              )?.label ?? answer!.value}
            </span>
          </div>
        )
      ) : (
        <div
          className="flex min-w-0 flex-wrap items-center gap-1.5"
          data-testid="chat-needs-reply"
          role="group"
          aria-label="Answer this question"
        >
          {writing ? (
            <form
              className="flex w-full min-w-0 max-w-xl flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  !optionsDisabled &&
                  (draft.text.trim() || draft.files.length)
                ) {
                  const text =
                    draft.text.trim() ||
                    `Attached: ${draft.files.map((file) => file.name).join(", ")}`;
                  onAnswer(
                    { value: text, label: text },
                    draft.files.map((file) => ({
                      type: "file",
                      fileId: file.id,
                    }))
                  );
                }
              }}
            >
              <Textarea
                rows={3}
                autoFocus
                aria-label="Your answer"
                maxLength={20000}
                placeholder="Your answer…"
                value={draft.text}
                className="min-h-24 resize-y border-primary/40 bg-background/60 text-sm shadow-none focus-visible:ring-primary/50"
                disabled={optionsDisabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    text: event.target.value,
                  }))
                }
                onPaste={(event) => {
                  const files = getClipboardFilesFromEvent(event);
                  if (files.length) {
                    event.preventDefault();
                    void attachFiles(files);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    backToChoices();
                  }
                }}
              />
              {draft.files.length ? (
                <fieldset
                  disabled={optionsDisabled}
                  className="flex min-w-0 flex-wrap gap-2"
                >
                  {draft.files.map((file) => (
                    <ContextChip
                      key={file.id}
                      icon={<Paperclip />}
                      title={file.name}
                      onRemove={() =>
                        setDraft((current) => ({
                          ...current,
                          files: current.files.filter(
                            (item) => item.id !== file.id
                          ),
                        }))
                      }
                      removeLabel={`Remove ${file.name}`}
                    />
                  ))}
                </fieldset>
              ) : null}
              {uploadError ? (
                <p role="alert" className="text-xs text-destructive">
                  {uploadError}
                </p>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={STARTUP_FILE_ACCEPT}
                aria-label="Attach files to answer"
                className="hidden"
                disabled={optionsDisabled}
                onChange={(event) => {
                  void attachFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <div className="flex items-center justify-between gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={ASK_ACTION}
                  disabled={answering || canceling || uploading}
                  onClick={backToChoices}
                >
                  <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                  Back to choices
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={ASK_ACTION}
                  aria-label="Attach files"
                  title="Attach files"
                  disabled={optionsDisabled}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {uploading ? (
                    <span className="sr-only">Uploading…</span>
                  ) : null}
                </Button>
                <Button
                  type="submit"
                  variant="default"
                  size="sm"
                  className={cn(
                    ASK_ACTION,
                    "shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
                  )}
                  disabled={
                    optionsDisabled ||
                    (!draft.text.trim() && !draft.files.length)
                  }
                >
                  {answering ? "Sending…" : "Send"}
                </Button>
              </div>
            </form>
          ) : (
            <>
              {block.data.options.map((option, index) => (
                <Button
                  key={`${index}-${option.value ?? option.label}`}
                  type="button"
                  size="sm"
                  variant="default"
                  className={ASK_CHOICE}
                  disabled={optionsDisabled}
                  data-testid="chat-question-option"
                  onClick={() => onAnswer(option)}
                >
                  {option.label}
                </Button>
              ))}
              {block.data.allowFreeform ? (
                <Button
                  ref={choiceRef}
                  type="button"
                  variant="default"
                  size="sm"
                  className={cn(ASK_CHOICE, "border-dashed bg-primary/10")}
                  disabled={optionsDisabled}
                  onClick={() => setWriting(true)}
                  data-testid="chat-question-write"
                >
                  Other…
                </Button>
              ) : null}
            </>
          )}
          <div
            className={
              writing ? "w-full border-t border-border/50 pt-1" : undefined
            }
          >
            <CancelAskButton
              label="Cancel question"
              disabled={answering || canceling || uploading}
              onCancel={onCancel}
            />
          </div>
        </div>
      )}
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
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  field: BlockFormField;
  value: FormValue | undefined;
  disabled: boolean;
  onChange: (value: FormValue) => void;
}): JSX.Element {
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
          className="min-h-[3.5rem] min-w-0 border border-border/70 bg-transparent px-2 text-xs shadow-none"
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
          className="h-7 min-w-0 max-w-[12rem] border border-border/70 bg-transparent px-2 text-xs shadow-none"
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
          <SelectTrigger
            id={id}
            className="h-7 min-w-0 max-w-[18rem] border border-border/70 bg-transparent px-2 text-xs shadow-none"
          >
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
          className="h-7 min-w-0 border border-border/70 bg-transparent px-2 text-xs shadow-none"
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
  const formId = useId();
  const submission = block.state?.submission;
  const cancellation = askCancellation(block);
  const [values, setValues] = useState(() =>
    initialFormValues(block.data.fields)
  );
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
      className="mt-2 max-w-xl"
      data-testid="chat-form"
      data-open={open ? "true" : undefined}
      onSubmit={submit}
    >
      {open ? (
        <div
          className={cn(
            "mb-2 text-xs font-medium",
            !block.data.title && "sr-only"
          )}
          data-testid="chat-needs-reply"
        >
          {block.data.title ?? "Fill in this form"}
        </div>
      ) : cancellation ? (
        <CanceledAskStatus cancellation={cancellation} />
      ) : (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Check className="h-3 w-3" />
          {block.data.title ? `${block.data.title} · submitted` : "Submitted"}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {block.data.fields.map((field) => {
          const label = (
            <label
              htmlFor={`${formId}-${field.id}`}
              className="min-w-0 break-words text-xs text-muted-foreground"
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
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-baseline gap-x-3 gap-y-0.5"
                data-testid="chat-form-value"
                data-field-id={field.id}
              >
                {label}
                <div className="whitespace-pre-wrap break-words text-xs text-foreground">
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
              className="grid min-h-7 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-x-3 gap-y-1"
              data-testid="chat-form-field"
              data-field-id={field.id}
            >
              {label}
              <FormFieldInput
                id={`${formId}-${field.id}`}
                field={field}
                value={values[field.id]}
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
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            type="submit"
            size="sm"
            variant="default"
            className={cn(
              ASK_CHOICE,
              "border-primary/40 bg-primary/10 text-primary"
            )}
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

export type ReviewBlock = Extract<Block, { kind: "review" }>;
export type FindingBlock = Extract<Block, { kind: "finding" }>;

/**
 * What a review's badge says, from where its findings stand: changes are
 * requested while any is open, and the review is approved once none is.
 * There is no second word for it to disagree with.
 */
export const REVIEW_STATUS: Record<
  BlockReviewStatus,
  { label: string; variant: "transitional" | "error"; edge: string }
> = {
  open: {
    label: "Changes requested",
    variant: "error",
    edge: "border-l-status-blocked",
  },
  partially_resolved: {
    label: "Changes requested",
    variant: "error",
    edge: "border-l-status-blocked",
  },
  resolved: {
    label: "Approved",
    variant: "transitional",
    edge: "border-l-status-done",
  },
};

/** A review's standing, from the finding blocks it shows. */
export function reviewStanding(review: ReviewBlock): BlockReviewStatus {
  return reviewStatus(reviewFindings(review));
}

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

/** A resolved finding was fixed unless it says dismissed; an open one is open. */
export function findingOutcome(
  record: BlockFindingState | null | undefined
): FindingOutcome {
  if (record?.status !== "resolved") return "open";
  return record.resolution === "dismissed" ? "dismissed" : "fixed";
}

/** "5 findings · 2 open", or "No findings". */
export function findingsSummary(block: ReviewBlock): string {
  const findings = reviewFindings(block);
  const total = findings.length;
  if (total === 0) return "No findings";
  const open = findings.filter((f) => f.state?.status !== "resolved").length;
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

/** Colours for a finding's status pill. */
const FINDING_STATUS_PILL: Record<FindingOutcome, string> = {
  open: "border-status-waiting/50 bg-status-waiting/10 text-status-waiting",
  fixed: "border-status-done/40 bg-status-done/10 text-status-done",
  dismissed: "border-border bg-muted/60 text-muted-foreground",
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
  finding: BlockFindingData;
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
            onClick={() => onPatch({ status: "fixed" })}
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
            onConfirm={(note) => onPatch({ status: "dismissed", note })}
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
            onPatch(note ? { status: "open", note } : { status: "open" })
          }
        />
      )}
    </div>
  );
}

/**
 * The latest change to a finding's record, as an entry in its thread, at
 * the time it was made: who fixed, dismissed or reopened it, and the note.
 * Null while the finding stands as its reviewer raised it.
 */
export function findingChange(
  block: Block
): { at: string; record: BlockFindingState } | null {
  if (block.kind !== "finding" || !block.state) return null;
  const record = block.state;
  if (record.status === "open" && record.note === undefined) return null;
  return { at: record.at, record };
}

/** A finding's change as a line of its thread: "✓ Fixed by reviewer · 5:13 PM". */
export function FindingChangeEntry({
  record,
  authorName,
}: {
  record: BlockFindingState;
  authorName: (by: BlockFindingState["by"]) => string;
}): JSX.Element {
  const outcome = findingOutcome(record);
  const Icon =
    outcome === "open" ? RotateCcw : outcome === "fixed" ? Check : XCircle;
  const verb =
    outcome === "open"
      ? "Reopened"
      : outcome === "fixed"
        ? "Fixed"
        : "Dismissed";
  return (
    <div
      className="mx-4 mt-3 flex min-w-0 items-start gap-2 text-xs text-muted-foreground"
      data-testid="chat-finding-change"
      data-outcome={outcome}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <span>
          <span className="font-medium text-foreground/80">{verb}</span> by{" "}
          {authorName(record.by)}
          {record.at ? ` · ${formatRelativeTime(record.at)}` : ""}
        </span>
        {record.note ? (
          <Markdown className="text-xs text-foreground/80">
            {record.note}
          </Markdown>
        ) : null}
      </div>
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
  disabled,
  onSetState,
  onOpenPath,
  authorName,
}: {
  block: FindingBlock;
  disabled: boolean;
  onSetState?: (patch: BlockStatePatch) => void;
  onOpenPath?: (path: string, line: number | null) => void;
  /** Names whoever last changed the finding. */
  authorName?: (by: BlockFindingState["by"]) => string;
}): JSX.Element {
  const finding = block.data;
  const record = block.state;
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
          onPatch={(patch) => onSetState(patch)}
        />
      ) : null}
      <Markdown className="text-sm text-foreground/90">{finding.body}</Markdown>
    </div>
  );
}

/**
 * A review as a card of its own, unlike a text post: an edge coloured by
 * where its findings stand, a header that says so and counts them, the
 * summary, and one compact row per finding (status, severity, title,
 * place, comments) that opens the finding's own thread. The full text and
 * the status controls live there. The fold animates.
 */
export function ReviewBlockBody({
  block,
  onOpenFinding,
  onOpenPath,
  highlightFindingId = null,
  defaultExpanded = false,
  compact = false,
  onOpen,
}: {
  block: ReviewBlock;
  /** Opens a finding's thread, by the finding block's id. */
  onOpenFinding?: (findingId: string) => void;
  /** Opens the Changes tab on a finding's file. */
  onOpenPath?: (path: string, line: number | null) => void;
  highlightFindingId?: string | null;
  defaultExpanded?: boolean;
  /**
   * The stream's card: the status, the counts and the summary's first
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
  const findings = reviewFindings(block);
  const standing = REVIEW_STATUS[reviewStatus(findings)];
  const open = findings.filter((f) => f.state?.status !== "resolved").length;
  const unread = findings.reduce(
    (sum, finding) => sum + (finding.unreadReplies ?? 0),
    0
  );
  return (
    <div
      className={cn(
        "mt-1 overflow-hidden rounded-md border border-border/60 border-l-[3px] bg-card/60",
        standing.edge
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
          variant={standing.variant}
          data-testid="chat-review-status"
          data-status={reviewStatus(findings)}
        >
          {standing.label}
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
                {findings.map((item) => {
                  const finding = item.data;
                  const record = item.state;
                  const status = record?.status ?? "open";
                  const comments = item.replyCount ?? 0;
                  const fresh = item.unreadReplies ?? 0;
                  const highlighted = highlightFindingId === item.id;
                  // The title has a line of its own, wrapping, so a narrow
                  // drawer or a phone still tells one finding from the next;
                  // the status, severity and counts sit under it.
                  const row = (
                    <>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span
                          className={cn(
                            "line-clamp-2 text-sm font-medium text-foreground [overflow-wrap:anywhere]",
                            status === "resolved" &&
                              "text-muted-foreground line-through"
                          )}
                          title={finding.title}
                          data-testid="chat-review-finding-title"
                        >
                          {finding.title}
                        </span>
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <FindingStatusPill record={record} />
                          <SeverityChip severity={finding.severity} />
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
                              {comments}{" "}
                              {comments === 1 ? "comment" : "comments"}
                            </span>
                          ) : null}
                          {fresh > 0 ? (
                            <span
                              className="h-2 w-2 shrink-0 rounded-full bg-primary"
                              data-testid="chat-review-finding-unread"
                              aria-label={`${fresh} new`}
                            />
                          ) : null}
                        </span>
                      </span>
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
                        aria-hidden="true"
                      />
                    </>
                  );
                  return (
                    <li
                      key={item.id}
                      className={cn(
                        "px-1",
                        highlighted && "rounded-md bg-primary/[0.08]"
                      )}
                      data-testid="chat-review-finding"
                      data-finding-id={item.id}
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
                          onClick={() => onOpenFinding(item.id)}
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
                {/* Item text is Markdown: agents cite issues and threads as
                    links, and a bare URL in a phone-width row is unreadable. */}
                <Markdown
                  variant="inline"
                  className={cn(
                    "text-sm",
                    checked
                      ? "text-muted-foreground line-through [&_a]:text-muted-foreground"
                      : "text-foreground"
                  )}
                >
                  {item.text}
                </Markdown>
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
