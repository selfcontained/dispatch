import { useEffect, useRef } from "react";
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
 * the post into the running turn when that is safe; otherwise it stops the
 * turn and the post opens the next one, the same as sending it as an
 * interrupt from the composer. The button is withheld only when neither is
 * possible for every recipient.
 */
export function QueuedMessageActions({
  agentId,
  messageId,
  canSendNow = true,
  recipientIds,
  threadId,
  requiresNextTurn = false,
  pendingDelivery = false,
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
}) {
  const client = useQueryClient();
  const agents = useDeliveryAgents();
  const recipients = (recipientIds ?? []).map((id) => ({ id, name: id }));
  const conversation = { streamId: agentId, threadId: threadId ?? null };
  const safeNow =
    !recipientIds ||
    recipientTimings(
      recipients,
      agents,
      conversation,
      "auto",
      requiresNextTurn
    ).every((item) => item.timing === "Now");
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
            className="h-6 gap-1 border border-transparent px-2 text-[11px] hover:border-status-waiting/40 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            disabled={action.isPending || action.isSuccess}
            title={
              pendingDelivery
                ? "Interrupt current work without resending this message"
                : sendNow === "interrupt"
                  ? "Stop the current turn and deliver this message as a new turn"
                  : "Deliver during the current turn when supported"
            }
            data-send-now={sendNow}
            onClick={() => action.mutate(sendNow)}
          >
            {sendNow === "interrupt" ? (
              <Zap className="h-3 w-3" aria-hidden="true" />
            ) : null}
            {pendingDelivery && action.isSuccess
              ? "Interrupt requested"
              : "Send now"}
          </Button>
        ) : null}
        {!pendingDelivery ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 border border-transparent p-0 hover:border-destructive/40 hover:bg-destructive/15 hover:text-destructive [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
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
        <span role="alert" className="col-span-2 text-xs text-destructive">
          {action.error.message}
        </span>
      ) : null}
    </>
  );
}
