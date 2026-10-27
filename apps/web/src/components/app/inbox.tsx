/**
 * The Inbox tab of the right sidebar: the open questions and forms an agent
 * is waiting on, answerable in place, plus agent progress and produced links.
 * Everything here is derived from the stream (see use-inbox.ts); the
 * agent has no tool to write to it directly.
 */
import { useState } from "react";
import type { BlockOption } from "@dispatch/shared";
import { reviewFindings, reviewStatus } from "@dispatch/shared";
import {
  ChevronRight,
  ExternalLink,
  GitPullRequest,
  InboxIcon,
} from "lucide-react";

import {
  findingsSummary,
  FormBlockBody,
  QuestionOptions,
  REVIEW_STATUS,
  taskStatus,
} from "@/components/app/chat/block-bodies";
import { LinkAttachment } from "@/components/app/chat/chat-attachment-views";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/ui/markdown";
import {
  useAnswerQuestion,
  useSetBlockState,
  useSubmitForm,
} from "@/hooks/use-stream";
import type {
  InboxInput,
  InboxReview,
  InboxChecklist,
  Inbox,
} from "@/hooks/use-inbox";
import { formatRelativeTime } from "@/lib/format";

export type InboxPanelProps = {
  inbox: Inbox;
  /** The page's agent, whose questions these are. */
  agentName: string | null;
  /** Names the author of each input when it is not the page's agent. */
  agentNameById?: (agentId: string) => string;
  /** Why answers cannot be sent right now, or null. */
  disabledReason: string | null;
  /** Opens the block's thread as a page in the drawer. */
  onOpenBlock?: (blockId: string) => void;
};

function InboxSectionTitle({
  children,
  count,
}: {
  children: string;
  count?: number;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
      {count !== undefined && count > 0 ? (
        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-foreground/80">
          {count}
        </span>
      ) : null}
    </div>
  );
}

function InboxInputCard({
  block,
  authorName,
  rootId,
  disabledReason,
  cancelError,
  onCancelError,
  onOpenBlock,
}: {
  block: InboxInput;
  authorName: string | null;
  rootId: string;
  disabledReason: string | null;
  cancelError: string | null;
  onCancelError: (message: string | null) => void;
  onOpenBlock?: (blockId: string) => void;
}): JSX.Element {
  const answer = useAnswerQuestion(rootId);
  const submit = useSubmitForm(rootId);
  const setState = useSetBlockState(rootId);
  const [error, setError] = useState<string | null>(null);
  const onAnswer = (option: BlockOption) => {
    setError(null);
    answer.mutate(
      {
        blockId: block.id,
        value: option.value ?? option.label,
        label: option.label,
      },
      { onError: (err) => setError(err.message) }
    );
  };
  const onSubmit = (values: Record<string, string | number | boolean>) => {
    setError(null);
    submit.mutate(
      { blockId: block.id, values },
      { onError: (err) => setError(err.message) }
    );
  };
  const onCancel = () => {
    setError(null);
    onCancelError(null);
    setState.mutate(
      { blockId: block.id, state: { cancellation: true } },
      { onError: (err) => onCancelError(err.message) }
    );
  };
  const actionPending =
    answer.isPending || submit.isPending || setState.isPending;
  return (
    <div
      className="mx-3 mb-2 rounded-md border border-border/60 bg-card/40 px-3 py-2"
      data-testid="inbox-input"
      data-block-id={block.id}
      data-kind={block.kind}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{authorName ?? "Agent"}</span>
        <button
          type="button"
          className="shrink-0 underline-offset-2 hover:underline"
          title={formatRelativeTime(block.createdAt)}
          // An ask made in a thread opens that thread, where it was asked.
          onClick={() => onOpenBlock?.(block.threadId ?? block.id)}
          data-testid="inbox-input-open"
        >
          {formatRelativeTime(block.createdAt)}
        </button>
      </div>
      {block.text ? (
        <Markdown className="mt-1 text-sm text-foreground prose-p:my-0.5">
          {block.text}
        </Markdown>
      ) : null}
      {block.kind === "question" ? (
        <QuestionOptions
          block={block}
          answering={answer.isPending && answer.variables?.blockId === block.id}
          answersDisabled={disabledReason !== null || actionPending}
          canceling={setState.isPending}
          onAnswer={onAnswer}
          onCancel={onCancel}
        />
      ) : (
        <FormBlockBody
          block={block}
          submitting={
            submit.isPending && submit.variables?.blockId === block.id
          }
          disabled={disabledReason !== null || actionPending}
          canceling={setState.isPending}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      )}
      {disabledReason ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          {disabledReason}
        </div>
      ) : null}
      {error || cancelError ? (
        <div
          role="alert"
          className="mt-1.5 text-[11px] text-destructive"
          data-testid="inbox-input-error"
        >
          {error ?? cancelError}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One review in the Inbox: who left it, where it stands, and how many of
 * its findings' comments the person has not seen. Opens the review: on
 * the launch card that shows it, when it is on one.
 */
function InboxReviewCard({
  review,
  authorName,
  onOpenBlock,
}: {
  review: InboxReview;
  authorName: string;
  onOpenBlock?: (blockId: string) => void;
}): JSX.Element {
  const findings = reviewFindings(review);
  const unread = findings.reduce(
    (sum, finding) => sum + (finding.unreadReplies ?? 0),
    0
  );
  const status = reviewStatus(findings);
  const standing = REVIEW_STATUS[status];
  return (
    <button
      type="button"
      className="mx-3 mb-2 flex w-[calc(100%-1.5rem)] flex-col gap-1 rounded-md border border-border/60 bg-card/40 px-3 py-2 text-left hover:bg-muted/30"
      data-testid="inbox-review"
      data-block-id={review.id}
      data-status={status}
      onClick={() => onOpenBlock?.(review.threadId ?? review.id)}
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{authorName}</span>
        <span className="shrink-0">{formatRelativeTime(review.createdAt)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {unread > 0 ? (
            <span
              className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground"
              data-testid="inbox-review-unread"
              aria-label={`${unread} new ${unread === 1 ? "comment" : "comments"}`}
            >
              {unread}
            </span>
          ) : null}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={standing.variant} data-testid="inbox-review-status">
          {standing.label}
        </Badge>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {findingsSummary(review)}
        </span>
      </div>
    </button>
  );
}

/** Progress only: opening the original block is the sole action. A reply's
 * own ID is a valid thread root; opening its parent would lose the checklist. */
function InboxChecklistCard({
  block,
  authorName,
  onOpenBlock,
}: {
  block: InboxChecklist;
  authorName: string;
  onOpenBlock?: (blockId: string) => void;
}): JSX.Element {
  const items = block.data.items;
  const done = items.filter(
    (item) => taskStatus(block, item.id) === "done"
  ).length;
  const current = items.find((item) => taskStatus(block, item.id) === "now");
  const next = items.find((item) => taskStatus(block, item.id) === "todo");
  const complete = items.length > 0 && done === items.length;
  const title = block.text.trim() || "Agent checklist";
  return (
    <Button
      type="button"
      variant="ghost"
      className="mx-3 mb-2 flex h-auto w-[calc(100%-1.5rem)] shrink-0 flex-col items-stretch justify-start gap-1 whitespace-normal font-normal rounded-md border border-border/60 bg-card/40 px-3 py-2 text-left hover:bg-muted/30"
      data-testid="inbox-checklist"
      data-block-id={block.id}
      data-complete={complete}
      onClick={() => onOpenBlock?.(block.id)}
      aria-label={`Open ${title} by ${authorName}, ${done}/${items.length} done`}
    >
      <div className="flex w-full items-center gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{authorName}</span>
        <span className="shrink-0" data-testid="inbox-checklist-progress">
          {done}/{items.length} done
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </div>
      <span className="line-clamp-2 break-words text-sm">{title}</span>
      <span
        className="line-clamp-2 break-words text-[11px] text-muted-foreground"
        data-testid="inbox-checklist-current"
      >
        {complete
          ? "Complete"
          : current
            ? `Now: ${current.text}`
            : next
              ? `Next: ${next.text}`
              : "No items yet"}
      </span>
    </Button>
  );
}

export function InboxPanel({
  inbox,
  agentName,
  agentNameById,
  disabledReason,
  onOpenBlock,
}: InboxPanelProps): JSX.Element {
  const { rootId, inputs, links, reviews, checklists, agentNames } = inbox;
  const checklistAuthorName = (block: InboxChecklist): string => {
    if (block.author.kind !== "agent") return "Agent";
    const liveName = agentNameById?.(block.author.agentId);
    return liveName && liveName !== "Agent"
      ? liveName
      : (agentNames[block.author.agentId] ?? "Agent");
  };
  const [cancelError, setCancelError] = useState<{
    blockId: string;
    message: string;
  } | null>(null);
  const empty =
    inputs.length === 0 &&
    links.length === 0 &&
    reviews.length === 0 &&
    checklists.length === 0;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3"
      data-testid="inbox"
      data-open-inputs={inputs.length}
    >
      {inbox.isLoading && empty ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          Loading the stream…
        </div>
      ) : empty ? (
        <div
          className="flex flex-col items-center gap-2 px-6 py-10 text-center text-xs text-muted-foreground"
          data-testid="inbox-empty"
        >
          <InboxIcon className="h-6 w-6 opacity-60" aria-hidden="true" />
          <div className="text-foreground/80">Nothing waiting on you.</div>
          <div>
            Questions and forms {agentName ?? "the agent"} asks show up here
            until you answer them, along with its checklists and links.
          </div>
        </div>
      ) : null}
      {inputs.length > 0 && rootId ? (
        <div data-testid="inbox-inputs">
          <InboxSectionTitle count={inputs.length}>Needs you</InboxSectionTitle>
          {inputs.map((block) => (
            <InboxInputCard
              key={block.id}
              block={block}
              authorName={
                block.author.kind === "agent"
                  ? (agentNameById?.(block.author.agentId) ?? agentName)
                  : agentName
              }
              rootId={rootId}
              disabledReason={disabledReason}
              cancelError={
                cancelError?.blockId === block.id ? cancelError.message : null
              }
              onCancelError={(message) =>
                setCancelError((previous) =>
                  message
                    ? { blockId: block.id, message }
                    : previous?.blockId === block.id
                      ? null
                      : previous
                )
              }
              onOpenBlock={onOpenBlock}
            />
          ))}
        </div>
      ) : null}
      {reviews.length > 0 && rootId ? (
        <div data-testid="inbox-reviews">
          <InboxSectionTitle
            count={
              reviews.filter(
                (review) => reviewStatus(reviewFindings(review)) !== "resolved"
              ).length
            }
          >
            Reviews
          </InboxSectionTitle>
          {reviews.map((review) => (
            <InboxReviewCard
              key={review.id}
              review={review}
              authorName={
                review.author.kind === "agent"
                  ? (agentNameById?.(review.author.agentId) ?? "Agent")
                  : "You"
              }
              onOpenBlock={onOpenBlock}
            />
          ))}
        </div>
      ) : null}
      {checklists.length > 0 ? (
        <div data-testid="inbox-checklists">
          <InboxSectionTitle count={checklists.length}>
            Agent progress
          </InboxSectionTitle>
          {checklists.map((block) => (
            <InboxChecklistCard
              key={block.id}
              block={block}
              authorName={checklistAuthorName(block)}
              onOpenBlock={onOpenBlock}
            />
          ))}
        </div>
      ) : null}
      {links.length > 0 ? (
        <div data-testid="inbox-links">
          <InboxSectionTitle>Links</InboxSectionTitle>
          <div className="flex flex-col gap-2 px-3">
            {links.map((link) => (
              <LinkAttachment
                key={`${link.blockId}:${link.url}`}
                href={link.url}
                title={link.title}
                icon={
                  link.pr ? (
                    <GitPullRequest className="h-3.5 w-3.5" />
                  ) : (
                    <ExternalLink className="h-3.5 w-3.5" />
                  )
                }
                testId="inbox-link"
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
