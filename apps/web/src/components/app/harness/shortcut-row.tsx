import { useState } from "react";
import { Zap } from "lucide-react";

import { ShortcutPinItem } from "@/components/app/pin-shortcut-item";
import { ConfirmShortcutDialog } from "@/components/app/pins-panel";
import type { AgentPin } from "@/components/app/types";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import {
  shouldConfirmShortcut,
  useRunPinShortcut,
} from "@/hooks/use-pin-shortcuts";

/**
 * The shortcut pins a turn wrote, as buttons where the agent said them.
 * The pins stay in the sidebar too; this is the same button, in place,
 * with the same run and confirm path.
 */
export function ShortcutRow({
  agentId,
  agentName,
  agentRunning,
  pins,
}: {
  agentId: string;
  agentName: string | null;
  agentRunning: boolean;
  pins: AgentPin[];
}): JSX.Element | null {
  const run = useRunPinShortcut();
  const coarsePointer = useCoarsePointer();
  const [pending, setPending] = useState<AgentPin | null>(null);
  if (pins.length === 0) return null;
  const fire = (pin: AgentPin) => {
    if (!pin.id || run.isPending) return;
    run.mutate({ agentId, pinId: pin.id, label: pin.label });
  };
  const groups = new Map<string, AgentPin[]>();
  for (const pin of pins) {
    const key = pin.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), pin]);
  }
  return (
    <div className="mb-3.5 pl-[21px]" data-testid="harness-shortcuts">
      {[...groups.entries()].map(([group, list]) => (
        <div key={group} className="mb-2 last:mb-0">
          <div className="mb-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <Zap className="h-3 w-3" aria-hidden="true" />
            <span>{group || "Shortcuts"}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {list.map((pin) => (
              <div
                key={pin.id ?? pin.label}
                className="min-w-[10rem] max-w-full"
              >
                <ShortcutPinItem
                  pin={pin}
                  inGroup
                  agentUnavailable={!agentRunning}
                  agentName={agentName}
                  pending={run.isPending && run.variables?.pinId === pin.id}
                  onRun={(pointerType) => {
                    if (
                      shouldConfirmShortcut(pin, pointerType, coarsePointer)
                    ) {
                      setPending(pin);
                      return;
                    }
                    fire(pin);
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
      <ConfirmShortcutDialog
        pin={pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        onConfirm={() => {
          if (pending) fire(pending);
          setPending(null);
        }}
      />
    </div>
  );
}
