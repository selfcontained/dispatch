import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { POST_ACTION_BUTTON, POST_ACTION_FACE } from "./chat-reactions";
import type { Block, BlockDeliveryState } from "@dispatch/shared";
import { AlertTriangle, Check, Info, Hourglass, Loader2 } from "lucide-react";

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
      <ReceiptStatus {...props} />
    </>
  );
}

function DeliveryStatus({
  block,
  recipientName,
  retrying = false,
  onRetryDelivery,
}: DeliveryMetaProps): JSX.Element | null {
  const pendingKey = inState(block, "pending").join(",");
  const [showSending, setShowSending] = useState(false);
  useEffect(() => {
    setShowSending(false);
    if (!pendingKey) return;
    const timer = setTimeout(() => setShowSending(true), 500);
    return () => clearTimeout(timer);
  }, [block.id, pendingKey]);
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
        <AlertTriangle className="h-3 w-3 shrink-0" />
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
        <Hourglass className="h-3 w-3 shrink-0" />
        {several
          ? `Queued for ${nameList(held, recipientName)}, until the turn ends`
          : "Queued until the turn ends"}
      </div>
    );
  }
  if (pending.length > 0 && showSending) {
    return (
      <div
        className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]"
        title="On its way to the agent."
        data-testid="chat-delivery-pending"
      >
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        {several
          ? `Sending to ${nameList(pending, recipientName)}`
          : "Sending…"}
      </div>
    );
  }
  return null;
}

/** Only changes observed while this row is mounted get a success flash. History
 * (including reload and virtualized rows) is quiet from its first render. */
function ReceiptStatus({
  block,
  recipientName,
}: DeliveryMetaProps): JSX.Element | null {
  const receipts = (block.delivery ?? []).filter(
    (entry) => entry.state === "delivered" && entry.receipt
  );
  const received = receipts.filter((entry) => entry.receipt?.pickedUpAt);
  const signature = JSON.stringify(
    received.map((entry) => [entry.agentId, entry.receipt!.pickedUpAt])
  );
  const previous = useRef({ blockId: block.id, signature });
  const [flashes, setFlashes] = useState<Record<string, number>>({});
  const reducedMotion = useReducedMotion();
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
  const waiting = receipts
    .filter((entry) => !entry.receipt?.pickedUpAt)
    .map((entry) => entry.agentId);
  const fresh = received
    .filter((entry) => flashes[entry.agentId])
    .map((entry) => entry.agentId);
  const several = (block.delivery?.length ?? 0) > 1;
  const show =
    block.toAgentId !== null && (waiting.length > 0 || fresh.length > 0);
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key={block.id}
          initial={false}
          animate={{ opacity: 1, height: "auto", marginTop: 4 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.2 }}
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 overflow-hidden text-[11px] text-muted-foreground"
          data-testid="chat-receipt-status"
        >
          {waiting.length > 0 ? (
            <span
              className="inline-flex min-w-0 max-w-full items-start gap-1 [overflow-wrap:anywhere]"
              title="Delivered to the runtime; receipt has not been confirmed."
              data-testid="chat-receipt-waiting"
            >
              <Hourglass
                className="mt-0.5 h-3 w-3 shrink-0"
                aria-hidden="true"
              />
              <span className="min-w-0">
                {several
                  ? `Waiting for ${nameList(waiting, recipientName)}…`
                  : "Waiting for agent…"}
              </span>
            </span>
          ) : null}
          {fresh.length > 0 ? (
            <span
              className="inline-flex min-w-0 max-w-full items-start gap-1 [overflow-wrap:anywhere]"
              title="The runtime confirmed receipt. This does not mean the agent has acted on the message."
              data-testid="chat-receipt-received"
            >
              <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                {several
                  ? `Received by ${nameList(fresh, recipientName)}`
                  : "Received"}
              </span>
            </span>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** A quiet, keyboard- and touch-accessible place for durable receipt details. */
export function DeliveryDetails({
  block,
  recipientName,
}: DeliveryMetaProps): JSX.Element | null {
  if (block.toAgentId === null || !block.delivery?.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`${POST_ACTION_BUTTON} shrink-0 data-[state=open]:opacity-100`}
          aria-label="Message delivery details"
          title="Message delivery details"
          data-testid="chat-delivery-details"
        >
          <span className={POST_ACTION_FACE}>
            <Info className="h-3.5 w-3.5" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Message delivery"
        align="end"
        className="max-w-[calc(100vw-24px)] space-y-3 text-xs [overflow-wrap:anywhere]"
      >
        <p className="font-medium">Message delivery</p>
        <p className="text-muted-foreground">
          Sent {timestamp(block.createdAt)}
        </p>
        {block.delivery.map((entry) => (
          <div key={entry.agentId} className="space-y-1">
            <p className="font-medium">{recipientName(entry.agentId)}</p>
            {entry.state === "delivered" ? (
              <>
                <p>
                  Delivered
                  {entry.receipt?.deliveredAt
                    ? ` ${timestamp(entry.receipt.deliveredAt)}`
                    : ""}
                </p>
                <p>
                  {entry.receipt?.pickedUpAt
                    ? `Received ${timestamp(entry.receipt.pickedUpAt)}`
                    : entry.receipt
                      ? "Waiting for agent…"
                      : "Receipt unavailable"}
                </p>
              </>
            ) : (
              <p>
                {entry.state === "held"
                  ? "Queued until the turn ends"
                  : entry.state === "failed"
                    ? "Not delivered"
                    : "Sending…"}
              </p>
            )}
          </div>
        ))}
        <p className="text-muted-foreground">
          Received means the runtime picked up the message, not that the agent
          has acted on it.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function timestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}
