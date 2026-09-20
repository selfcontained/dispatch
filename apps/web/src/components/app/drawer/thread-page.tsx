/**
 * A thread as a drawer page: the block, its replies, a composer. On a
 * review it is the review page (verdict, summary, the findings as rows);
 * with a finding it is that finding's page (the item in full, its status
 * controls, its own comments). The page carries its own handlers, so the
 * drawer works the same whichever tab the centre is on.
 */
import { useCallback, useMemo, useState } from "react";
import type { BlockOption } from "@dispatch/shared";

import type { BlockStatePatch } from "@/components/app/chat/block-bodies";
import { composerDisabledReason } from "@/components/app/chat/composer-disabled";
import { ThreadPanel } from "@/components/app/chat/thread-panel";
import { useChatFeedContext } from "@/components/app/chat/use-chat-feed-context";
import { type Agent } from "@/components/app/types";
import {
  useAnswerQuestion,
  useSetBlockState,
  useSubmitForm,
  useToggleReaction,
} from "@/hooks/use-stream";

export type ThreadPageProps = {
  agentId: string;
  agent: Agent | null;
  rootId: string;
  blockId: string;
  findingId: string | null;
  isMobile: boolean;
  openLightbox: (fileId: number) => void;
  onOpenPath?: (path: string, line: number | null) => void;
  onOpenThread: (blockId: string, findingId?: string) => void;
  onOpenTurn?: (turnId: string) => void;
  onBack: () => void;
};

export function ThreadPage({
  agentId,
  agent,
  rootId,
  blockId,
  findingId,
  isMobile,
  openLightbox,
  onOpenPath,
  onOpenThread,
  onOpenTurn,
  onBack,
}: ThreadPageProps): JSX.Element {
  const answer = useAnswerQuestion(rootId);
  const submitForm = useSubmitForm(rootId);
  const setBlockState = useSetBlockState(rootId);
  const reaction = useToggleReaction(rootId);
  const [error, setError] = useState<string | null>(null);

  const { mutate: answerNow } = answer;
  const onAnswer = useCallback(
    (id: string, option: BlockOption) => {
      setError(null);
      answerNow(
        {
          blockId: id,
          value: option.value ?? option.label,
          label: option.label,
        },
        { onError: (err) => setError(err.message) }
      );
    },
    [answerNow]
  );
  const { mutate: submitNow } = submitForm;
  const onSubmitForm = useCallback(
    (id: string, values: Record<string, string | number | boolean>) => {
      setError(null);
      submitNow(
        { blockId: id, values },
        { onError: (err) => setError(err.message) }
      );
    },
    [submitNow]
  );
  const { mutate: setStateNow } = setBlockState;
  const onSetBlockState = useCallback(
    (id: string, patch: BlockStatePatch) => {
      setError(null);
      setStateNow(
        { blockId: id, state: patch },
        { onError: (err) => setError(err.message) }
      );
    },
    [setStateNow]
  );
  const { mutate: reactNow } = reaction;
  const onToggleReaction = useCallback(
    (id: string, emoji: string, remove: boolean) => {
      setError(null);
      reactNow(
        { blockId: id, emoji, remove },
        { onError: (err) => setError(err.message) }
      );
    },
    [reactNow]
  );

  const { ctx } = useChatFeedContext({
    agentId,
    rootId,
    agent,
    openLightbox,
    onOpenPath,
    onToggleReaction,
    onOpenThread,
    onOpenTurn,
    onSubmitForm,
    onSetBlockState,
  });
  const disabledReason = useMemo(() => composerDisabledReason(agent), [agent]);

  return (
    <ThreadPanel
      agentId={agentId}
      rootId={rootId}
      blockId={blockId}
      findingId={findingId}
      ctx={ctx}
      disabledReason={disabledReason}
      isMobile={isMobile}
      chrome={false}
      onClose={onBack}
      onAnswer={onAnswer}
      answeringBlockId={
        answer.isPending ? (answer.variables?.blockId ?? null) : null
      }
      submittingBlockId={
        submitForm.isPending ? (submitForm.variables?.blockId ?? null) : null
      }
      error={error}
    />
  );
}
