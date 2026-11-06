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
        "grid grid-cols-1 gap-2 sm:gap-3 [&>*]:min-w-0",
        showModel && showEffort
          ? "grid-cols-[minmax(6rem,1fr)_minmax(0,1.4fr)_4.75rem]"
          : showEffort
            ? "grid-cols-[minmax(0,1fr)_4.75rem]"
            : showModel && "grid-cols-2",
        className
      )}
    >
      {children}
    </div>
  );
}
