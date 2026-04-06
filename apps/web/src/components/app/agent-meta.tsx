import { useRef, useState, useLayoutEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type AgentMetaProps = {
  label: string;
  value: string;
  mono?: boolean;
  /** Truncate from the front with ellipsis, showing a tooltip with the full value. */
  truncateStart?: boolean;
};

type FrontTruncatedValueProps = {
  value: string;
  mono: boolean;
  className?: string;
  tooltipClassName?: string;
};

export function FrontTruncatedValue({
  value,
  mono,
  className,
  tooltipClassName,
}: FrontTruncatedValueProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [display, setDisplay] = useState(value);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Reset to full value to measure
    setDisplay(value);

    // Use rAF to let the DOM update before measuring
    const frame = requestAnimationFrame(() => {
      if (!containerRef.current) return;
      const container = containerRef.current;

      // If it fits, no truncation needed
      if (container.scrollWidth <= container.clientWidth) return;

      // Binary search for how many chars from the end fit
      let lo = 0;
      let hi = value.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = `\u2026${value.slice(mid)}`;
        container.textContent = candidate;
        if (container.scrollWidth > container.clientWidth) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      setDisplay(`\u2026${value.slice(lo)}`);
    });

    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          ref={containerRef}
          className={cn("text-foreground whitespace-nowrap overflow-hidden", mono && "font-mono text-[11px]", className)}
        >
          {display}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className={cn("max-w-[360px] break-all text-xs font-mono", tooltipClassName)}>
        {value}
      </TooltipContent>
    </Tooltip>
  );
}

export function AgentMeta({ label, value, mono = false, truncateStart = false }: AgentMetaProps): JSX.Element {
  return (
    <div className="grid gap-1">
      <div className="uppercase tracking-wide text-[10px] text-muted-foreground/80">{label}</div>
      {truncateStart ? (
        <FrontTruncatedValue value={value} mono={mono} />
      ) : (
        <div className={cn("text-foreground", mono && "font-mono text-[11px]", "break-all")}>{value}</div>
      )}
    </div>
  );
}
