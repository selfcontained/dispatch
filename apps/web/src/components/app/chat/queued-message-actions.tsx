import { useEffect, useRef } from "react";
import { sameConversation } from "@dispatch/shared";
import { useDeliveryAgents } from "@/hooks/use-agent-tree";
import { recipientTimings } from "./composer-delivery";
import { Trash2, Zap } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { streamFeedQueryKey } from "@/hooks/use-stream";
import { api } from "@/lib/api";

type QueuedAction = "delete" | "send-now" | "interrupt";

/**
 * What a person can do with a post waiting behind a turn. Send now steers
 * the post into the running turn when that is safe and the turn is in the
 * post's own conversation; otherwise it stops the turn and the post opens
 * the next one, the same as sending it as an interrupt from the composer.
 * The server makes the same conversation check, so this label is a preview
 * of its decision rather than the only guard. The button is withheld only
 * when neither is possible for every recipient.
 */
export function QueuedMessageActions({
  agentId,
  messageId,
  canSendNow = true,
  recipientIds,
  threadId,
  requiresNextTurn = false,
  pendingDelivery = false,
  resumesAsk = false,
}: {
  agentId: string;
  messageId: string;
  canSendNow?: boolean;
  recipientIds?: readonly string[];
  threadId?: string | null;
  /** Images cannot steer into a turn; the post needs one of its own. */
  requiresNextTurn?: boolean;
  /** Already being handed off: interrupt without replacing the attempt. */
  pendingDelivery?: boolean;
  /**
   * An answer to a question or form: it resumes the conversation that
   * asked, so it never needs its own turn to land in the right place.
   */
  resumesAsk?: boolean;
}) {
  const client = useQueryClient();
  const agents = useDeliveryAgents();
  const recipients = (recipientIds ?? []).map((id) => ({ id, name: id }));
  const conversation = { streamId: agentId, threadId: threadId ?? null };
  const safeNow =
    !requiresNextTurn &&
    recipients.every(({ id }) => {
      const agent = agents.find((item) => item.id === id);
      const busy =
        agent?.inputState?.active ??
        (!!agent?.currentTurn || agent?.activity === "working");
      if (!busy) return true;
      const active = agent?.inputState?.conversation;
      // Steering a post into a turn in another conversation would answer it
      // there, not where it was sent.
      if (!resumesAsk && active && !sameConversation(conversation, active))
        return false;
      return agent?.inputState?.steeringSupported === true;
    });
  const canInterrupt =
    !!recipientIds &&
    recipientTimings(recipients, agents, conversation, "interrupt").every(
      (item) => item.timing === "Now" || item.timing === "Interrupt"
    );
  const pendingCanInterrupt =
    canInterrupt &&
    recipients.some(
      ({ id }) => agents.find((agent) => agent.id === id)?.inputState?.active
    );
  const sendNow: QueuedAction | null = pendingDelivery
    ? pendingCanInterrupt
      ? "interrupt"
      : null
    : safeNow
      ? "send-now"
      : canInterrupt
        ? "interrupt"
        : null;
  const action = useMutation({
    mutationFn: (kind: QueuedAction) =>
      api<void>(
        `/api/v1/streams/${encodeURIComponent(agentId)}/blocks/${encodeURIComponent(messageId)}${kind === "delete" ? "" : "/send-now"}`,
        kind === "delete"
          ? { method: "DELETE" }
          : {
              method: "POST",
              body: JSON.stringify({
                interrupt: kind === "interrupt",
                ...(pendingDelivery ? { keepDelivery: true } : {}),
              }),
            }
      ),
    onSettled: () =>
      client.invalidateQueries({ queryKey: streamFeedQueryKey(agentId) }),
  });
  const actionScope = JSON.stringify([
    messageId,
    pendingDelivery,
    recipients.map(({ id }) => {
      const agent = agents.find((item) => item.id === id);
      return [id, agent?.currentTurn?.blockId, agent?.inputState?.active];
    }),
  ]);
  const previousScope = useRef(actionScope);
  const { isPending, reset } = action;
  useEffect(() => {
    // Do not drop an in-flight request; release its latch once the row or turn changes.
    if (isPending || previousScope.current === actionScope) return;
    previousScope.current = actionScope;
    reset();
  }, [actionScope, isPending, reset]);
  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5">
        {canSendNow && sendNow ? (
          <Button
            variant="ghost-warning"
            size="sm"
            className="h-6 gap-1 border border-transparent px-2 text-label-sm hover:border-warning/line-strong [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            disabled={action.isPending || action.isSuccess}
            title={
              pendingDelivery
                ? "Interrupt current work without resending this message"
                : sendNow === "interrupt"
                  ? "Stop the current turn and deliver this message as a new turn"
                  : "Join ongoing work in this conversation"
            }
            data-send-now={sendNow}
            onClick={() => action.mutate(sendNow)}
          >
            {sendNow === "interrupt" ? (
              <Zap className="h-3 w-3" aria-hidden="true" />
            ) : null}
            {pendingDelivery && action.isSuccess
              ? "Interrupt requested"
              : sendNow === "interrupt" && !pendingDelivery
                ? "Send now (stops current turn)"
                : "Send now"}
          </Button>
        ) : null}
        {!pendingDelivery ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 border border-transparent p-0 hover:border-danger/line-strong hover:bg-danger/tint-strong hover:text-danger [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            aria-label="Delete"
            disabled={action.isPending || action.isSuccess}
            title="Delete this queued message so it will not be delivered"
            onClick={() => action.mutate("delete")}
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {action.isError ? (
        <span role="alert" className="col-span-2 text-body-sm text-danger">
          {action.error.message}
        </span>
      ) : null}
    </>
  );
}
