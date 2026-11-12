import type { Pool } from "pg";
import type { Block } from "@dispatch/shared";

import type { AgentRecord } from "../agents/manager.js";
import { requestOwnerAgentId } from "../agents/tree.js";
import type { PostInput } from "../chat/service.js";
import type { NotifyInput, NotifyResult } from "../shared/mcp/server.js";
import type { QuestionAlerts } from "./question-alerts.js";

/**
 * `notify({ form })`: the form is an ordinary Dispatch form, created through
 * the same post path as post({ form }) so its location, validation and answer
 * routing are unchanged; only its Slack alert skips the reminder wait.
 */
export async function notifyForm(
  deps: {
    pool: Pool;
    post: (agentId: string, input: PostInput) => Promise<Block>;
    alerts: Pick<QuestionAlerts, "sendNow">;
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
  const block = await deps.post(agent.id, {
    to: null,
    text: input.message,
    form: {
      ...input.form,
      ...(input.title && !input.form.title ? { title: input.title } : {}),
    },
  });
  const form = {
    id: block.id,
    streamId: block.streamId,
    threadId: block.threadId,
  };
  const outcome = await deps.alerts.sendNow(block.id).catch(() => ({
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
