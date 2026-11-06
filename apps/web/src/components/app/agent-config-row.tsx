import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keep launch choices together; give model names the most room. */
export function AgentConfigRow({
  children,
  showModel = true,
  showEffort = true,
  className,
}: {
  children: ReactNode;
  showModel?: boolean;
  showEffort?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 [&>*]:min-w-0",
        showModel && showEffort
          ? "min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)]"
          : (showModel || showEffort) && "min-[420px]:grid-cols-2",
        className
      )}
    >
      {children}
    </div>
  );
}
