import type { Pool, PoolClient } from "pg";
import type { Block } from "@dispatch/shared";

import type { AgentRecord } from "../agents/manager.js";
import { requestOwnerAgentId } from "../agents/tree.js";
import type { PostInput } from "../chat/service.js";
import type { NotifyInput, NotifyResult } from "../shared/mcp/server.js";
import { QuestionAlerts } from "./question-alerts.js";
import {
  inTurnThread,
  type SlackThreadReplies,
  type ThreadTarget,
  type TurnThread,
} from "./slack-thread-replies.js";

/**
 * `notify({ form })`: the form is an ordinary Dispatch form, created through
 * the same post path as post({ form }) so its validation and answer routing
 * are unchanged; only its Slack alert skips the reminder wait.
 *
 * Where it goes in Slack:
 * - with replyTo (a post that came from a Slack thread): into that thread,
 *   and the Dispatch form is a reply to that post;
 * - without replyTo, during a turn answering a Slack thread post: into that
 *   thread, exactly where post({ form }) would have put it;
 * - otherwise: the channel, as a new alert.
 * Exactly one sender: this call. post's own automatic thread ask is skipped
 * so the two can't both post it.
 *
 * A form bound for a Slack thread is reserved to that thread (and its Slack
 * connection) in the same transaction that creates it, before any reminder
 * worker can see it. It is then only ever sent to that thread: if Slack is
 * reconnected or the send can't run, it stays unsent and answerable in
 * Dispatch, and is never rerouted to the channel root or a new connection.
 * A form with no thread target follows the ordinary reminder rules.
 */
export async function notifyForm(
  deps: {
    pool: Pool;
    post: (
      agentId: string,
      input: PostInput,
      opts: {
        skipExternalAsk: true;
        afterInsert: (db: PoolClient, block: Block) => Promise<void>;
      }
    ) => Promise<Block>;
    alerts: Pick<QuestionAlerts, "sendNow">;
    threads: Pick<SlackThreadReplies, "threadTarget" | "turnThread">;
  },
  agent: AgentRecord,
  input: NotifyInput & { form: NonNullable<NotifyInput["form"]> }
): Promise<NotifyResult> {
  // A child's forms go to its parent agent, never to a person in Slack.
  if (await requestOwnerAgentId(deps.pool, agent.id))
    return {
      sent: false,
      reason:
        "Your forms go to your parent agent, not Slack. Nothing was created; ask your parent with post.",
    };
  let target: ThreadTarget | null = null;
  if (input.replyTo) {
    const found = await deps.threads.threadTarget(agent.id, input.replyTo);
    if (!found.ok) return { sent: false, reason: found.reason };
    target = found.target;
  }
  // Every lookup happens before the insert transaction; inside it, only the
  // reservation write runs (no second pool connection while one is held).
  // A failed lookup fails the call with nothing created: guessing "no thread"
  // could send a Slack follow-up's form to the channel root.
  const turn: TurnThread | null = target
    ? null
    : await deps.threads.turnThread(agent.id);
  const block = await deps.post(
    agent.id,
    {
      to: null,
      text: input.message,
      ...(target ? { replyTo: target.postId } : {}),
      form: {
        ...input.form,
        ...(input.title && !input.form.title ? { title: input.title } : {}),
      },
    },
    {
      skipExternalAsk: true,
      // Inside the insert transaction: no worker can enroll it first.
      afterInsert: async (db, created) => {
        target ??= inTurnThread(turn, created);
        if (target)
          await QuestionAlerts.reserveThread(db, created.id, {
            threadTs: target.threadTs,
            generation: target.generation,
          });
      },
    }
  );
  const form = {
    id: block.id,
    streamId: block.streamId,
    threadId: block.threadId,
  };
  const outcome = await deps.alerts
    .sendNow(
      block.id,
      target
        ? { threadTs: target.threadTs, generation: target.generation }
        : undefined
    )
    .catch(() => ({
      delivery: "retrying" as const,
      reason: "Dispatch couldn't send the alert yet and will retry it.",
    }));
  if (outcome.delivery === "sent")
    return { sent: true, form, delivery: "sent" };
  return {
    sent: false,
    form,
    delivery: outcome.delivery,
    reason: `${outcome.reason} The form is open in Dispatch either way.`,
  };
}
