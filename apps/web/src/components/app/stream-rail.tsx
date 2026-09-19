/**
 * The Rail tab of the right sidebar: the open questions and forms an agent
 * is waiting on, answerable in place, and the links the stream produced.
 * Everything here is derived from the stream (see use-stream-rail.ts); the
 * agent has no tool to write to it directly.
 */
import { useState } from "react";
import type { BlockOption } from "@dispatch/shared";
import { ExternalLink, GitPullRequest, Inbox } from "lucide-react";

import {
  FormBlockBody,
  QuestionOptions,
} from "@/components/app/chat/block-bodies";
import { LinkAttachment } from "@/components/app/chat/chat-attachment-views";
import { Markdown } from "@/components/ui/markdown";
import { useAnswerQuestion, useSubmitForm } from "@/hooks/use-stream";
import type { RailInput, StreamRail } from "@/hooks/use-stream-rail";
import { formatRelativeTime } from "@/lib/format";

export type StreamRailPanelProps = {
  rail: StreamRail;
  /** The page's agent, whose questions these are. */
  agentName: string | null;
  /** Names the author of each input when it is not the page's agent. */
  agentNameById?: (agentId: string) => string;
  /** Why answers cannot be sent right now, or null. */
  disabledReason: string | null;
  /** Opens the block in the feed (the thread panel). */
  onOpenBlock?: (blockId: string) => void;
};

function RailSectionTitle({
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

function RailInputCard({
  block,
  authorName,
  rootId,
  disabledReason,
  onOpenBlock,
}: {
  block: RailInput;
  authorName: string | null;
  rootId: string;
  disabledReason: string | null;
  onOpenBlock?: (blockId: string) => void;
}): JSX.Element {
  const answer = useAnswerQuestion(rootId);
  const submit = useSubmitForm(rootId);
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
  return (
    <div
      className="mx-3 mb-2 rounded-md border border-border/60 bg-card/40 px-3 py-2"
      data-testid="rail-input"
      data-block-id={block.id}
      data-kind={block.kind}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{authorName ?? "Agent"}</span>
        <button
          type="button"
          className="shrink-0 underline-offset-2 hover:underline"
          title={formatRelativeTime(block.createdAt)}
          onClick={() => onOpenBlock?.(block.id)}
          data-testid="rail-input-open"
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
          answersDisabled={disabledReason !== null}
          onAnswer={onAnswer}
        />
      ) : (
        <FormBlockBody
          block={block}
          submitting={
            submit.isPending && submit.variables?.blockId === block.id
          }
          disabled={disabledReason !== null}
          onSubmit={onSubmit}
        />
      )}
      {disabledReason ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          {disabledReason}
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mt-1.5 text-[11px] text-destructive"
          data-testid="rail-input-error"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function StreamRailPanel({
  rail,
  agentName,
  agentNameById,
  disabledReason,
  onOpenBlock,
}: StreamRailPanelProps): JSX.Element {
  const { rootId, inputs, links } = rail;
  const empty = inputs.length === 0 && links.length === 0;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3"
      data-testid="stream-rail"
      data-open-inputs={inputs.length}
    >
      {rail.isLoading && empty ? (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          Loading the stream…
        </div>
      ) : empty ? (
        <div
          className="flex flex-col items-center gap-2 px-6 py-10 text-center text-xs text-muted-foreground"
          data-testid="stream-rail-empty"
        >
          <Inbox className="h-6 w-6 opacity-60" aria-hidden="true" />
          <div className="text-foreground/80">Nothing waiting on you.</div>
          <div>
            Questions and forms {agentName ?? "the agent"} asks show up here
            until you answer them, along with the links it posts.
          </div>
        </div>
      ) : null}
      {inputs.length > 0 && rootId ? (
        <div data-testid="stream-rail-inputs">
          <RailSectionTitle count={inputs.length}>Needs you</RailSectionTitle>
          {inputs.map((block) => (
            <RailInputCard
              key={block.id}
              block={block}
              authorName={
                block.author.kind === "agent"
                  ? (agentNameById?.(block.author.agentId) ?? agentName)
                  : agentName
              }
              rootId={rootId}
              disabledReason={disabledReason}
              onOpenBlock={onOpenBlock}
            />
          ))}
        </div>
      ) : null}
      {links.length > 0 ? (
        <div data-testid="stream-rail-links">
          <RailSectionTitle>Links</RailSectionTitle>
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
                testId="stream-rail-link"
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
