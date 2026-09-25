import type { Block, BlockDeliveryState } from "@dispatch/shared";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Hourglass,
  Loader2,
} from "lucide-react";

/** The recipients of a post in one of the states worth reporting. */
function inState(block: Block, state: BlockDeliveryState): readonly string[] {
  return (block.delivery ?? [])
    .filter((entry) => entry.state === state)
    .map((entry) => entry.agentId);
}

/** "builder", "builder and reviewer", "builder, reviewer and scout". */
function nameList(
  agentIds: readonly string[],
  recipientName: (id: string) => string
): string {
  const names = agentIds.map(recipientName);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Where a post addressed to agents has got to. Steering also distinguishes
 * runtime acceptance from confirmed pickup. A queued message is
 * the part a reader has to be able to see: waiting behind a turn is a
 * normal state a message sits in, not a failure, and it says so in as many
 * words. Recipients are named only when a post went to more than one, so
 * an ordinary message keeps its quiet single line.
 */
type DeliveryMetaProps = {
  block: Block;
  recipientName: (id: string) => string;
  retrying?: boolean;
  onRetryDelivery?: (blockId: string) => void;
};

export function DeliveryMeta(props: DeliveryMetaProps): JSX.Element | null {
  return (
    <>
      <DeliveryStatus {...props} />
      <SteeringReceipts {...props} />
    </>
  );
}

function DeliveryStatus({
  block,
  recipientName,
  retrying = false,
  onRetryDelivery,
}: DeliveryMetaProps): JSX.Element | null {
  if (block.toAgentId === null || !block.delivery?.length) return null;
  const several = block.delivery.length > 1;
  const failed = inState(block, "failed");
  const held = inState(block, "held");
  const pending = inState(block, "pending");

  if (failed.length > 0) {
    return (
      <div
        className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-destructive [overflow-wrap:anywhere]"
        title="The message was not taken: the agent had no session, or its engine stopped responding."
        data-testid="chat-delivery-failed"
      >
        <AlertTriangle className="h-3 w-3" />
        {several
          ? `Not delivered to ${nameList(failed, recipientName)}`
          : "Not delivered"}
        {/* The same post, sent again, and only to whoever missed it:
            nothing new lands in the stream and nobody reads it twice. Not
            "Retry", which on a failed turn runs the agent again. */}
        {onRetryDelivery ? (
          <button
            type="button"
            className="underline underline-offset-2 hover:no-underline disabled:opacity-60"
            disabled={retrying}
            onClick={() => onRetryDelivery?.(block.id)}
            data-testid="chat-delivery-retry"
          >
            {retrying ? "Sending…" : "Send again"}
          </button>
        ) : null}
      </div>
    );
  }
  if (held.length > 0) {
    return (
      <div
        className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]"
        title={
          block.kind === "text" && block.data?.acpCommand
            ? "This command will run after the current turn."
            : "Your message will be delivered after the current turn. Send now delivers during the turn when supported."
        }
        data-testid="chat-held-hint"
      >
        <Hourglass className="h-3 w-3" />
        {several
          ? `Queued for ${nameList(held, recipientName)}, until the turn ends`
          : "Queued until the turn ends"}
      </div>
    );
  }
  if (pending.length > 0) {
    return (
      <div
        className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]"
        title="On its way to the agent."
        data-testid="chat-delivery-pending"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {several ? `Sending to ${nameList(pending, recipientName)}` : "Sending"}
      </div>
    );
  }
  return null;
}

function SteeringReceipts({
  block,
  recipientName,
}: DeliveryMetaProps): JSX.Element | null {
  if (block.toAgentId === null || !block.delivery?.length) return null;
  const several = block.delivery.length > 1;
  const receipts = block.delivery.filter(
    (entry) => entry.state === "delivered" && entry.steering
  );
  if (!receipts.length) return null;
  const pickedUp = receipts
    .filter((entry) => entry.steering?.pickedUpAt)
    .map((entry) => entry.agentId);
  const accepted = receipts
    .filter((entry) => !entry.steering?.pickedUpAt)
    .map((entry) => entry.agentId);
  return (
    <div
      className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
      data-testid="chat-steering-receipt"
    >
      {pickedUp.length > 0 ? (
        <span
          className="inline-flex min-w-0 max-w-full items-start gap-1 [overflow-wrap:anywhere]"
          title="The agent runtime confirmed it picked up this message for processing."
          data-testid="chat-steering-picked-up"
        >
          <CheckCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {several
              ? `Picked up by ${nameList(pickedUp, recipientName)}`
              : "Picked up"}
          </span>
        </span>
      ) : null}
      {accepted.length > 0 ? (
        <span
          className="inline-flex min-w-0 max-w-full items-start gap-1 [overflow-wrap:anywhere]"
          title="The agent accepted this message. Pickup has not been confirmed."
          data-testid="chat-steering-delivered"
        >
          <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {several
              ? `Delivered to ${nameList(accepted, recipientName)}`
              : "Delivered"}
          </span>
        </span>
      ) : null}
    </div>
  );
}
