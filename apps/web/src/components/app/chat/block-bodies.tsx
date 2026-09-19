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
  BlockFindingStatus,
  BlockFormField,
  BlockOption,
  BlockReviewSeverity,
  BlockReviewVerdict,
  BlockTaskStatus,
} from "@dispatch/shared";
import {
  Check,
  ChevronRight,
  ExternalLink,
  Link2,
  RotateCcw,
} from "lucide-react";

import { LinkAttachment } from "@/components/app/chat/chat-attachment-views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** A state patch for `PATCH …/blocks/:id/state`. */
export type BlockStatePatch = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export function QuestionOptions({
  block,
  answering,
  answersDisabled,
  onAnswer,
}: {
  block: Extract<Block, { kind: "question" }>;
  /** This question's answer is in flight. */
  answering: boolean;
  /** Nothing can be sent right now, so neither buttons nor a typed reply. */
  answersDisabled: boolean;
  onAnswer: (option: BlockOption) => void;
}): JSX.Element {
  const answer = block.state?.answer;
  const open = answer === undefined;
  const optionsDisabled = !open || answering || answersDisabled;
  return (
    <div
      className={cn(
        "mt-2 rounded-md border p-3",
        open
          ? "border-status-waiting/50 bg-status-waiting/[0.07]"
          : "border-border bg-muted/30"
      )}
      data-testid="chat-question-options"
    >
      {open ? (
        <div
          className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-status-waiting"
          data-testid="chat-needs-reply"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Needs your reply
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Check className="h-3 w-3" />
          Answered
          <span className="truncate">· {answer.label ?? answer.value}</span>
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
                "h-7 gap-1 text-xs",
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
  onSubmit,
}: {
  block: Extract<Block, { kind: "form" }>;
  /** This form's submission is in flight. */
  submitting: boolean;
  /** Nothing can be sent right now. */
  disabled: boolean;
  onSubmit: (values: Record<string, FormValue>) => void;
}): JSX.Element {
  const submission = block.state?.submission;
  const [values, setValues] = useState(() =>
    initialFormValues(block.data.fields)
  );
  const open = submission === undefined;
  const missing = block.data.fields.some(
    (field) => field.required && isBlank(values[field.id])
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (missing || submitting || disabled) return;
    onSubmit(values);
  };
  return (
    <form
      className={cn(
        "mt-2 rounded-md border p-3",
        open
          ? "border-status-waiting/50 bg-status-waiting/[0.07]"
          : "border-border bg-muted/30"
      )}
      data-testid="chat-form"
      data-open={open ? "true" : undefined}
      onSubmit={submit}
    >
      {open ? (
        <div
          className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-status-waiting"
          data-testid="chat-needs-reply"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          {block.data.title ?? "Needs your input"}
        </div>
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
          if (!open) {
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
                value={values[field.id]}
                disabled={disabled || submitting}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, [field.id]: value }))
                }
              />
            </div>
          );
        })}
      </div>
      {open ? (
        <div className="mt-3">
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
        </div>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

const VERDICT: Record<
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

const FINDING_STATUS_LABEL: Record<BlockFindingStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  disputed: "Disputed",
};

/** `state.findings[id].status`, `open` when nothing has been recorded. */
export function findingStatus(
  block: Extract<Block, { kind: "review" }>,
  findingId: string
): BlockFindingStatus {
  return block.state?.findings?.[findingId]?.status ?? "open";
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

/** The wire shape of a finding status change: a bare status per finding. */
export function findingStatePatch(
  findingId: string,
  status: BlockFindingStatus
): BlockStatePatch {
  return { findings: { [findingId]: status } };
}

/**
 * A review as one line by default — verdict, the summary's first sentence,
 * "5 findings · 2 open" — that opens into compact finding rows: severity
 * chip, title, path:line, status, and a resolve/reopen action. A row's
 * title deep-links into the review's thread with that finding highlighted.
 * In the panel (`expanded`, `showBodies`) the rows also carry their bodies.
 */
export function ReviewBlockBody({
  block,
  disabled,
  onSetState,
  onOpenFinding,
  highlightFindingId = null,
  defaultExpanded = false,
  showBodies = false,
}: {
  block: Extract<Block, { kind: "review" }>;
  /** State changes are unavailable (no callback, or nothing can be sent). */
  disabled: boolean;
  onSetState?: (patch: BlockStatePatch) => void;
  /** Opens the review's thread on this finding. */
  onOpenFinding?: (findingId: string) => void;
  highlightFindingId?: string | null;
  defaultExpanded?: boolean;
  showBodies?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const verdict = VERDICT[block.data.verdict] ?? VERDICT.comment;
  const findings = block.data.findings;
  const setStatus = (findingId: string, status: BlockFindingStatus) =>
    onSetState?.(findingStatePatch(findingId, status));
  const sentence = summarySentence(block.data.summary);
  return (
    <div
      className="mt-1"
      data-testid="chat-review-block"
      data-expanded={expanded ? "true" : undefined}
    >
      <button
        type="button"
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left"
        aria-expanded={expanded}
        data-testid="chat-review-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90"
          )}
          aria-hidden="true"
        />
        <Badge
          variant={verdict.variant}
          data-testid="chat-review-verdict"
          data-verdict={block.data.verdict}
        >
          {verdict.label}
        </Badge>
        {sentence ? (
          <span className="min-w-0 truncate text-sm text-foreground">
            {sentence}
          </span>
        ) : null}
        <span
          className="shrink-0 text-[11px] text-muted-foreground"
          data-testid="chat-review-counts"
        >
          {findingsSummary(block)}
        </span>
      </button>
      {expanded ? (
        <div className="mt-2" data-testid="chat-review-details">
          {block.data.summary && block.data.summary !== sentence ? (
            <Markdown className="mb-2 text-muted-foreground prose-p:my-0.5">
              {block.data.summary}
            </Markdown>
          ) : null}
          {findings.length > 0 ? (
            <ol
              className="flex flex-col divide-y divide-border/40 border-t border-border/40"
              data-testid="chat-review-findings"
            >
              {findings.map((finding) => {
                const status = findingStatus(block, finding.id);
                const isResolved = status === "resolved";
                const highlighted = highlightFindingId === finding.id;
                return (
                  <li
                    key={finding.id}
                    className={cn(
                      "-mx-2 px-2 py-1.5",
                      isResolved && "opacity-70",
                      highlighted && "rounded-md bg-primary/[0.08]"
                    )}
                    data-testid="chat-review-finding"
                    data-finding-id={finding.id}
                    data-status={status}
                    data-highlighted={highlighted ? "true" : undefined}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
                          SEVERITY_CHIP[finding.severity] ?? SEVERITY_CHIP.minor
                        )}
                        data-testid="chat-review-severity"
                      >
                        {finding.severity}
                      </span>
                      {onOpenFinding ? (
                        <button
                          type="button"
                          className={cn(
                            "min-w-0 truncate text-sm font-medium text-foreground underline-offset-2 hover:underline",
                            isResolved && "line-through"
                          )}
                          data-testid="chat-review-finding-link"
                          onClick={() => onOpenFinding(finding.id)}
                        >
                          {finding.title}
                        </button>
                      ) : (
                        <span
                          className={cn(
                            "min-w-0 truncate text-sm font-medium text-foreground",
                            isResolved && "line-through"
                          )}
                        >
                          {finding.title}
                        </span>
                      )}
                      {finding.path ? (
                        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                          {finding.path}
                          {finding.line !== undefined ? `:${finding.line}` : ""}
                        </span>
                      ) : null}
                      <span
                        className="shrink-0 text-[11px] text-muted-foreground"
                        data-testid="chat-review-finding-status"
                      >
                        {FINDING_STATUS_LABEL[status]}
                      </span>
                      {onSetState ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 gap-1 px-1.5 text-[11px]"
                          disabled={disabled}
                          data-testid={
                            isResolved
                              ? "chat-review-reopen"
                              : "chat-review-resolve"
                          }
                          onClick={() =>
                            setStatus(
                              finding.id,
                              isResolved ? "open" : "resolved"
                            )
                          }
                        >
                          {isResolved ? (
                            <>
                              <RotateCcw
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                              Reopen
                            </>
                          ) : (
                            <>
                              <Check className="h-3 w-3" aria-hidden="true" />
                              Resolve
                            </>
                          )}
                        </Button>
                      ) : null}
                    </div>
                    {showBodies && finding.body ? (
                      <Markdown className="mt-1 text-muted-foreground prose-p:my-0.5">
                        {finding.body}
                      </Markdown>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      ) : null}
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
 * A checklist. Ticking an item marks it done, unticking puts it back to
 * todo; the one the agent is on (`now`) carries a small marker. Once every
 * item is done the list folds to its count line and opens on click.
 */
export function TasksBlockBody({
  block,
  disabled,
  onSetState,
}: {
  block: Extract<Block, { kind: "tasks" }>;
  disabled: boolean;
  onSetState?: (patch: BlockStatePatch) => void;
}): JSX.Element {
  const items = block.data.items;
  const done = items.filter((i) => taskStatus(block, i.id) === "done").length;
  const allDone = items.length > 0 && done === items.length;
  const [opened, setOpened] = useState<boolean | null>(null);
  const expanded = opened ?? !allDone;
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
                <Checkbox
                  className="mt-0.5 h-4 w-4"
                  checked={checked}
                  disabled={disabled || !onSetState}
                  aria-label={item.text}
                  onCheckedChange={(next) =>
                    onSetState?.({
                      items: { [item.id]: next === true ? "done" : "todo" },
                    })
                  }
                />
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
