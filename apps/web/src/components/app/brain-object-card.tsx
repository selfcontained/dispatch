import {
  AgentIdLabel,
  CopyButton,
  DeleteButton,
  RelativeTime,
} from "@/components/app/brain-card-shared";
import { panelFrame } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { KeyValueTable } from "@/components/app/brain-key-value-table";
import type { BrainObject } from "@/hooks/use-brain";

export function ObjectCard({
  obj,
  agentId,
  revision,
  onDelete,
}: {
  obj: BrainObject;
  agentId?: string;
  revision?: number;
  onDelete?: () => void;
}): JSX.Element {
  return (
    <div className={cn(panelFrame, "mx-3 mb-2 overflow-hidden p-2")}>
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="flex items-center gap-1.5 text-body-sm min-w-0">
          <span className="rounded-sm bg-chart-3/tint-strong px-1.5 py-0.5 font-mono text-chart-3 text-label-xs shrink-0">
            {obj.collection}
          </span>
          <span className="font-medium truncate">{obj.name}</span>
          {revision !== undefined ? (
            <span className="text-label-xs text-muted-foreground shrink-0">
              rev {revision}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-label-xs text-muted-foreground shrink-0">
          {agentId ? <AgentIdLabel agentId={agentId} /> : null}
          <CopyButton value={obj.value} />
          {onDelete ? (
            <DeleteButton
              label={`Delete object ${obj.name}`}
              onClick={onDelete}
            />
          ) : null}
          <RelativeTime iso={obj.updatedAt} />
        </div>
      </div>
      <div className="rounded-sm bg-surface-subtle px-2 py-2 overflow-x-auto">
        <KeyValueTable
          value={{
            ...(typeof obj.value === "object" &&
            obj.value !== null &&
            !Array.isArray(obj.value)
              ? (obj.value as Record<string, unknown>)
              : { value: obj.value }),
            updatedAt: obj.updatedAt,
          }}
        />
      </div>
    </div>
  );
}
