import type { HTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

type LogStreamProps = HTMLAttributes<HTMLDivElement> & {
  viewportRef?: Ref<HTMLDivElement>;
};

export function LogStream({ viewportRef, className, ...props }: LogStreamProps): JSX.Element {
  return (
    <div
      ref={viewportRef}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto rounded-md border p-4 font-mono text-[12px] leading-relaxed shadow-inner",
        "border-[hsl(var(--log-stream-border))] bg-[hsl(var(--log-stream-bg))] text-[hsl(var(--log-stream-foreground))]",
        className
      )}
      {...props}
    />
  );
}
