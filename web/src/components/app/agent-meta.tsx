import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type AgentMetaProps = {
  label: string;
  value: string;
  mono?: boolean;
  /** Truncate from the front with ellipsis, showing a tooltip with the full value. */
  truncateStart?: boolean;
};

export function AgentMeta({ label, value, mono = false, truncateStart = false }: AgentMetaProps): JSX.Element {
  const valueEl = (
    <div
      className={cn(
        "text-foreground",
        mono && "font-mono text-[11px]",
        truncateStart ? "truncate direction-rtl text-left" : "break-all"
      )}
    >
      {truncateStart ? `\u200F${value}` : value}
    </div>
  );

  return (
    <div className="grid gap-1">
      <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">{label}</div>
      {truncateStart ? (
        <Tooltip>
          <TooltipTrigger asChild>{valueEl}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-[360px] break-all text-xs font-mono">
            {value}
          </TooltipContent>
        </Tooltip>
      ) : (
        valueEl
      )}
    </div>
  );
}
