import {
  AgentIdLabel,
  CopyButton,
  DeleteButton,
  RelativeTime,
} from "@/components/app/brain-card-shared";
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
    <div className="mx-3 mb-2 rounded-md border border-border bg-muted/20 p-2.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span className="rounded bg-sky-950/50 px-1.5 py-0.5 font-mono text-sky-400 text-[10px] shrink-0">
            {obj.collection}
          </span>
          <span className="font-medium truncate">{obj.name}</span>
          {revision !== undefined ? (
            <span className="text-[10px] text-muted-foreground shrink-0">
              rev {revision}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
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
      <div className="rounded bg-muted/30 px-2.5 py-2 overflow-x-auto">
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
