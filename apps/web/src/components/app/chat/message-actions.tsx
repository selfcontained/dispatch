import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type { RoutingDiagnostic, Block } from "@dispatch/shared";
import {
  MoreHorizontal,
  Info,
  MessageSquarePlus,
  SmilePlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/format";
import {
  POST_ACTION_BUTTON,
  POST_ACTION_FACE,
  ReactionPickerOptions,
} from "./chat-reactions";
import { RoutingDecisionDetails } from "./routing-decision";

/** Recipient data is persisted delivery provenance; explicit failed/pending receipts win. */
function receivedBy(block: Block): string[] {
  const data =
    block.kind === "text" || block.kind === "task" ? block.data : null;
  const declared = [...(data?.mentions ?? []), ...(data?.recipients ?? [])];
  const candidates = [
    ...new Set([
      ...(block.toAgentId ? [block.toAgentId] : []),
      ...declared,
      ...(block.delivery ?? [])
        .filter((d) => d.state === "delivered")
        .map((d) => d.agentId),
    ]),
  ];
  return candidates.filter((id) => {
    const receipt = block.delivery?.find((d) => d.agentId === id);
    if (receipt) return receipt.state === "delivered";
    return (
      declared.includes(id) ||
      (block.toAgentId === id && block.delivered === true)
    );
  });
}

/** Each message owns its overflow and detail dialogs. */
export function MessageActions({
  block,
  copy,
  senderName,
  agentName,
  onReply,
  onReact,
  reactionsDisabled,
}: {
  block: Block;
  copy?: ReactNode;
  senderName: string;
  agentName: (id: string) => string;
  onReply?: () => void;
  onReact?: (emoji: string, remove: boolean) => void;
  reactionsDisabled: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<"metadata" | "react" | null>(null);
  const recipients = receivedBy(block);
  const deliveries: NonNullable<Block["delivery"]> = block.delivery?.length
    ? block.delivery
    : recipients.map((agentId) => ({ agentId, state: "delivered" }));
  return (
    <>
      <Popover
        open={panel === "react"}
        onOpenChange={(open) => {
          if (!open && panel === "react") setPanel(null);
        }}
      >
        <PopoverAnchor asChild>
          <div className="flex items-center gap-0.5">
            {copy}
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={`${POST_ACTION_BUTTON} data-[state=open]:opacity-100`}
                  aria-label="Message actions"
                  ref={actionsRef}
                  title="Message actions"
                >
                  <span className={POST_ACTION_FACE}>
                    <MoreHorizontal
                      className="h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  if (panel) event.preventDefault();
                }}
              >
                <DropdownMenuItem
                  className="flex items-center gap-2 text-foreground"
                  onSelect={() => {
                    setMenuOpen(false);
                    setPanel("metadata");
                  }}
                >
                  <Info className="h-4 w-4" />
                  Message metadata
                </DropdownMenuItem>
                {onReply && (
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-foreground"
                    onSelect={onReply}
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                    Reply in thread
                  </DropdownMenuItem>
                )}
                {onReact && (
                  <DropdownMenuItem
                    className="flex items-center gap-2 text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                    disabled={reactionsDisabled}
                    title={
                      reactionsDisabled
                        ? "The agent cannot receive reactions right now."
                        : undefined
                    }
                    onSelect={() => {
                      setMenuOpen(false);
                      setPanel("react");
                    }}
                  >
                    <SmilePlus className="h-4 w-4" />
                    React
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="end"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            actionsRef.current?.focus();
          }}
          className="w-auto p-1.5"
          aria-label="React to message"
        >
          {onReact && (
            <ReactionPickerOptions
              reactions={block.reactions ?? []}
              onToggle={onReact}
              onPicked={() => setPanel(null)}
            />
          )}
        </PopoverContent>
      </Popover>
      <Dialog
        open={panel === "metadata"}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            actionsRef.current?.focus();
          }}
          className="w-[calc(100vw-2rem)] max-w-sm gap-2 p-3 sm:p-4"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle className="text-sm tracking-tight">
              Message metadata
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[70dvh] space-y-2 overflow-y-auto pr-1">
            <section className="space-y-1.5" aria-label="Message delivery">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
                <p className="break-words text-xs font-medium">
                  <span className="mr-1.5 font-normal text-muted-foreground">
                    From
                  </span>
                  {senderName}
                </p>
                <time
                  dateTime={block.createdAt}
                  className="block text-[10px] text-muted-foreground"
                >
                  {formatDateTime(block.createdAt)}
                </time>
              </div>
              <div className="space-y-1">
                {!!deliveries.length && (
                  <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Delivery
                  </h3>
                )}
                {deliveries.map((delivery) => {
                  const receipt = delivery.receipt;
                  const state =
                    delivery.state === "failed"
                      ? "Failed"
                      : delivery.state === "held"
                        ? "Queued"
                        : delivery.state === "pending"
                          ? "Sending"
                          : receipt?.pickedUpAt
                            ? "Received"
                            : receipt?.deliveredAt
                              ? "Sent · awaiting pickup"
                              : "Delivered · pickup unconfirmed";
                  return (
                    <div key={delivery.agentId} className="text-[10px]">
                      <div className="flex flex-wrap items-center justify-between gap-x-2">
                        <span className="text-muted-foreground">
                          {agentName(delivery.agentId)}
                        </span>
                        <span
                          className={
                            delivery.state === "failed"
                              ? "text-destructive"
                              : receipt?.pickedUpAt
                                ? "text-green-600 dark:text-green-400"
                                : "text-foreground"
                          }
                        >
                          {state}
                          {receipt?.mode === "steering"
                            ? " · steering"
                            : receipt?.mode === "prompt"
                              ? " · new turn"
                              : ""}
                        </span>
                      </div>
                      {(receipt?.deliveredAt || receipt?.pickedUpAt) && (
                        <div className="flex flex-wrap justify-end gap-x-2 text-muted-foreground">
                          {receipt.deliveredAt && (
                            <time title={formatDateTime(receipt.deliveredAt)}>
                              Sent{" "}
                              {new Date(receipt.deliveredAt).toLocaleTimeString(
                                [],
                                {
                                  hour: "numeric",
                                  minute: "2-digit",
                                  second: "2-digit",
                                }
                              )}
                            </time>
                          )}
                          {receipt.pickedUpAt && (
                            <time title={formatDateTime(receipt.pickedUpAt)}>
                              Picked up{" "}
                              {new Date(receipt.pickedUpAt).toLocaleTimeString(
                                [],
                                {
                                  hour: "numeric",
                                  minute: "2-digit",
                                  second: "2-digit",
                                }
                              )}
                            </time>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!block.delivery?.length && !recipients.length && (
                  <span className="text-[10px] text-muted-foreground">
                    Delivery unavailable
                  </span>
                )}
              </div>
            </section>
            {block.author.kind === "user" && (
              <MessageRoutingDetails block={block} agentName={agentName} />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Mounted only while the metadata dialog is open: closed messages own no metadata query observers. */
function MessageRoutingDetails({
  block,
  agentName,
}: {
  block: Block;
  agentName: (id: string) => string;
}) {
  const metadata = useQuery({
    queryKey: ["message-metadata", block.streamId, block.id],
    queryFn: () =>
      api<{ routing: RoutingDiagnostic[] }>(
        `/api/v1/streams/${encodeURIComponent(block.streamId)}/blocks/${block.id}/metadata`
      ),
    enabled: block.author.kind === "user",
    staleTime: Infinity,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });
  const routing =
    block.author.kind === "user" ? (metadata.data?.routing ?? []) : [];
  return (
    <>
      {metadata.isFetching && !metadata.data && (
        <p className="text-xs text-muted-foreground">
          Loading routing details…
        </p>
      )}
      {metadata.isError && (
        <p className="text-xs text-destructive">
          Couldn’t load routing details.
        </p>
      )}
      {routing.map((d) => (
        <RoutingDecisionDetails
          key={`${d.agentId}:${d.turnId}`}
          diagnostic={d}
          agentName={agentName(d.agentId)}
        />
      ))}
    </>
  );
}
