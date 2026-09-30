import { ListEnd, WandSparkles, Zap } from "lucide-react";
import { sameConversation, type PromptConversation } from "@dispatch/shared";
import type { Agent } from "@/components/app/types";
import type { Mentionable } from "@/lib/mentions";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export type DeliveryMode = "auto" | "queue" | "interrupt";

export type DeliveryAgent = Pick<
  Agent,
  "id" | "activity" | "currentTurn" | "inputState"
>;

export type RecipientTiming = {
  id: string;
  name: string;
  busy: boolean;
  interruptSupported: boolean;
  timing: "Now" | "Queued" | "Interrupt" | "Unavailable";
  reason: string;
};

export function recipientTimings(
  recipients: readonly Mentionable[],
  agents: readonly DeliveryAgent[],
  conversation: PromptConversation,
  mode: DeliveryMode,
  requiresNextTurn = false
): RecipientTiming[] {
  return recipients.map(({ id, name }) => {
    const agent = agents.find((item) => item.id === id);
    const busy =
      agent?.inputState?.active ??
      (!!agent?.currentTurn || agent?.activity === "working");
    // Persisted currentTurn can be stale and says nothing about steering support.
    const activeConversation = agent?.inputState?.conversation ?? null;
    const same = sameConversation(conversation, activeConversation);
    const unsupported = agent?.inputState?.steeringSupported !== true;
    const interruptSupported = agent?.inputState?.interruptSupported === true;
    const timing =
      busy && mode === "interrupt"
        ? interruptSupported
          ? "Interrupt"
          : "Unavailable"
        : busy && (mode === "queue" || requiresNextTurn || unsupported || !same)
          ? "Queued"
          : "Now";
    const reason = !busy
      ? "Ready for a new turn."
      : mode === "interrupt"
        ? interruptSupported
          ? "Stop current turn, then respond here."
          : "This recipient does not support interrupting active work."
        : unsupported
          ? "This session accepts messages after its current turn."
          : !activeConversation
            ? "Waiting for the active conversation to be confirmed."
            : requiresNextTurn
              ? "Images and commands need their own turn."
              : mode === "queue"
                ? "You chose to wait for the current turn to finish."
                : same
                  ? "Continues the active conversation."
                  : "Working in another conversation; this message starts its own turn next.";
    return { id, name, busy, interruptSupported, timing, reason };
  });
}

export function ComposerDelivery({
  timings,
  mode,
  onMode,
  unavailableReason,
}: {
  timings: RecipientTiming[];
  mode: DeliveryMode;
  onMode: (mode: DeliveryMode) => void;
  unavailableReason?: string | null;
}) {
  if (mode === "auto" && !timings.some((item) => item.busy)) return null;
  const interruptUnavailable =
    Boolean(unavailableReason) ||
    timings.some((item) => item.busy && !item.interruptSupported);
  const label = unavailableReason
    ? "Unavailable"
    : new Set(timings.map((item) => item.timing)).size > 1
      ? "Mixed"
      : timings[0]?.timing;
  const ModeIcon =
    mode === "interrupt" ? Zap : mode === "queue" ? ListEnd : WandSparkles;
  const modeLabel =
    mode === "interrupt"
      ? "Interrupt current work"
      : mode === "queue"
        ? "Queue for next turn"
        : "Automatic";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          aria-label={`Message timing: ${label}`}
          aria-description={`${modeLabel} delivery mode. Open to change.`}
          title={`${modeLabel} · ${label}`}
          data-testid="chat-composer-delivery"
        >
          <ModeIcon className="h-4 w-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] space-y-3 p-3"
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <div className="space-y-2 text-xs" aria-live="polite">
          {timings.map((item) => (
            <div key={item.id}>
              <div className="flex justify-between gap-3 font-medium">
                <span className="truncate">{item.name}</span>
                <span>{item.timing}</span>
              </div>
              <p className="mt-0.5 text-muted-foreground">{item.reason}</p>
            </div>
          ))}
        </div>
        <div
          className="flex flex-col gap-1"
          role="group"
          aria-label="Delivery preference"
        >
          {(
            [
              { value: "auto", label: "Automatic", Icon: WandSparkles },
              { value: "queue", label: "Queue for next turn", Icon: ListEnd },
              {
                value: "interrupt",
                label: "Interrupt current work",
                Icon: Zap,
              },
            ] as const
          ).map(({ value, label: optionLabel, Icon }) => (
            <Button
              key={value}
              type="button"
              variant={mode === value ? "default" : "ghost"}
              size="sm"
              aria-pressed={mode === value}
              disabled={value === "interrupt" && interruptUnavailable}
              onClick={() => onMode(value)}
              className="justify-start gap-2 pointer-coarse:min-h-11"
              data-testid={`chat-composer-${value}`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {optionLabel}
            </Button>
          ))}
          {interruptUnavailable ? (
            <p className="text-xs text-muted-foreground">
              {unavailableReason ??
                "Interrupt is unavailable for a busy recipient on an older host."}
            </p>
          ) : null}
          {mode === "interrupt" ? (
            <p className="text-xs text-muted-foreground">
              Interrupt applies when you send. The provider may take time to
              stop an active tool.
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
