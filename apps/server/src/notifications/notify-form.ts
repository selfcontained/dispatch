import type { Pool } from "pg";
import type { Block } from "@dispatch/shared";

import type { AgentRecord } from "../agents/manager.js";
import { requestOwnerAgentId } from "../agents/tree.js";
import type { PostInput } from "../chat/service.js";
import type { NotifyInput, NotifyResult } from "../shared/mcp/server.js";
import type { QuestionAlerts } from "./question-alerts.js";
import type {
  SlackThreadReplies,
  ThreadTarget,
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
 * If the send can't even be claimed (the Slack connection changed after the
 * thread was checked, or the claim itself failed), nothing reached Slack and
 * the form falls back to the ordinary reminder: a channel alert if it is
 * still unanswered after five minutes, under the current connection. That is
 * deliberate: the old thread may no longer exist, and the person still
 * needs the form.
 */
export async function notifyForm(
  deps: {
    pool: Pool;
    post: (
      agentId: string,
      input: PostInput,
      opts: { skipExternalAsk: true }
    ) => Promise<Block>;
    alerts: Pick<QuestionAlerts, "sendNow">;
    threads: Pick<SlackThreadReplies, "threadTarget" | "turnTarget">;
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
    { skipExternalAsk: true }
  );
  const form = {
    id: block.id,
    streamId: block.streamId,
    threadId: block.threadId,
  };
  target ??= await deps.threads.turnTarget(agent.id, block).catch(() => null);
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
