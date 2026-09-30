import { useEffect, useRef, useState } from "react";
import type { Block, BlockDeliveryState } from "@dispatch/shared";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Hourglass,
  Loader2,
  Zap,
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
  return <DeliveryStatus {...props} />;
}

function DeliveryStatus({
  block,
  recipientName,
  retrying = false,
  onRetryDelivery,
}: DeliveryMetaProps): JSX.Element | null {
  if (block.toAgentId === null || !block.delivery?.length) return null;
  const several = block.delivery.length > 1;
  const interrupt =
    block.kind === "text" && block.data?.delivery === "interrupt";
  const failed = inState(block, "failed");
  const held = inState(block, "held");

  if (failed.length > 0) {
    return (
      <div
        className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-destructive [overflow-wrap:anywhere]"
        title={
          interrupt
            ? "The stop request or message delivery failed. Your message is saved; retry to request interruption again."
            : "The message was not taken: the agent had no session, or its engine stopped responding."
        }
        data-testid="chat-delivery-failed"
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        {interrupt
          ? several
            ? `Interrupt failed for ${nameList(failed, recipientName)}`
            : "Interrupt failed"
          : several
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
            {retrying
              ? "Sending…"
              : interrupt
                ? "Try interrupt again"
                : "Send again"}
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
          interrupt
            ? `Stop requested${several ? ` for ${nameList(held, recipientName)}` : ""}. Delivery waits for the current turn to stop; running tools may take time to cancel.`
            : block.kind === "text" && block.data?.acpCommand
              ? "This command will run after the current turn."
              : "Your message will be delivered in its own conversation after the current turn."
        }
        data-testid="chat-held-hint"
      >
        {interrupt ? (
          <Zap className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <Hourglass className="h-3 w-3 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">
          {interrupt
            ? several
              ? `Stop requested · ${held.length} agents`
              : "Stop requested"
            : several
              ? `Queued for ${nameList(held, recipientName)}, until the turn ends`
              : "Queued until the turn ends"}
        </span>
      </div>
    );
  }

  return null;
}

/** Only changes observed while this row is mounted get a success flash. History
 * (including reload and virtualized rows) is quiet from its first render. */
function useReceiptFlash(block: Block): boolean {
  const receipts = (block.delivery ?? []).filter(
    (entry) => entry.state === "delivered" && entry.receipt
  );
  const received = receipts.filter((entry) => entry.receipt?.pickedUpAt);
  const signature = JSON.stringify(
    received.map((entry) => [entry.agentId, entry.receipt!.pickedUpAt])
  );
  const previous = useRef({ blockId: block.id, signature });
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  useEffect(() => {
    const before = previous.current;
    previous.current = { blockId: block.id, signature };
    if (before.blockId !== block.id) {
      setFlashes({});
      return;
    }
    const old = new Map<string, string>(JSON.parse(before.signature));
    const current = new Map<string, string>(JSON.parse(signature));
    setFlashes((existing) => {
      const next: Record<string, number> = {};
      for (const [id, at] of current) {
        if (old.get(id) !== at) next[id] = Date.now() + 2000;
        else if (existing[id]) next[id] = existing[id];
      }
      return next;
    });
  }, [block.id, signature]);
  useEffect(() => {
    const deadlines = Object.values(flashes);
    if (!deadlines.length) return;
    const timer = setTimeout(
      () =>
        setFlashes((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([, until]) => until > Date.now())
          )
        ),
      Math.max(0, Math.min(...deadlines) - Date.now())
    );
    return () => clearTimeout(timer);
  }, [flashes]);
  return received.some((entry) => !!flashes[entry.agentId]);
}

/** Non-interactive receipt mark. Its fixed-size slot stays in place after
 * the confirmation fades, so message content and actions never shift. */
export function DeliveryIndicator({
  block,
}: Pick<DeliveryMetaProps, "block">): JSX.Element {
  const freshReceipt = useReceiptFlash(block);
  const pendingKey = inState(block, "pending").join(",");
  const [showSending, setShowSending] = useState(false);
  useEffect(() => {
    setShowSending(false);
    if (!pendingKey) return;
    const timer = setTimeout(() => setShowSending(true), 500);
    return () => clearTimeout(timer);
  }, [block.id, pendingKey]);

  const deliveries = block.delivery ?? [];
  const received = deliveries.filter(
    (entry) => entry.state === "delivered" && entry.receipt?.pickedUpAt
  ).length;
  const awaitingReceipt = deliveries.some(
    (entry) =>
      entry.state === "delivered" && entry.receipt && !entry.receipt.pickedUpAt
  );
  const needsAction = deliveries.some(
    (entry) => entry.state === "held" || entry.state === "failed"
  );
  const status =
    needsAction || block.toAgentId === null
      ? undefined
      : pendingKey
        ? showSending
          ? "Sending…"
          : undefined
        : awaitingReceipt
          ? "Sent"
          : freshReceipt && received === deliveries.length
            ? "Received"
            : undefined;
  // Keep the success color after the flash expires so the double check
  // fades out in green instead of changing back to gray during its exit.
  const confirmed =
    !needsAction &&
    !pendingKey &&
    received > 0 &&
    received === deliveries.length;
  const Icon =
    status === "Sending…" ? Loader2 : status === "Sent" ? Check : CheckCheck;
  const label =
    status === "Sent" && deliveries.length > 1
      ? `Sent · ${received} of ${deliveries.length} agents received it`
      : status;
  return (
    <span
      className={`flex h-4 w-4 items-center justify-center transition-[color,opacity] duration-500 motion-reduce:transition-none ${confirmed ? "text-green-700 [[data-theme-mode=dark]_&]:text-green-500" : "text-muted-foreground"} ${status ? "opacity-100" : "opacity-0"}`}
      data-testid="chat-delivery-indicator"
      data-status={status}
      role="status"
      aria-label={label}
      title={label}
    >
      <Icon
        className={`h-3 w-3 ${status === "Sending…" ? "animate-spin motion-reduce:animate-none" : ""}`}
        aria-hidden="true"
        data-testid={
          status === "Sending…"
            ? "chat-delivery-pending"
            : status === "Sent"
              ? "chat-receipt-sent"
              : status === "Received"
                ? "chat-receipt-received"
                : undefined
        }
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
