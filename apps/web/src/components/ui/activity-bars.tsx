import { cn } from "@/lib/utils";

export interface ActivityBarsProps {
  size?: number;
  className?: string;
}

// Listed as static strings so Tailwind's JIT picks them up.
// Keyframes `dispatch-bar-wave-*` are defined in index.css.
const BAR_ANIMATION_CLASSES = [
  "animate-[dispatch-bar-wave-0_2.4s_ease-in-out_infinite]",
  "animate-[dispatch-bar-wave-1_2.4s_ease-in-out_infinite]",
  "animate-[dispatch-bar-wave-2_2.4s_ease-in-out_infinite]",
  "animate-[dispatch-bar-wave-3_2.4s_ease-in-out_infinite]",
] as const;

export function ActivityBars({
  size = 24,
  className,
}: ActivityBarsProps): JSX.Element {
  const bar = Math.max(2, size / 8);
  const gap = Math.max(1, size / 12);

  return (
    <div
      className={cn("flex items-center justify-center", className)}
      style={{ gap, height: size, width: size }}
      role="status"
      aria-label="Loading"
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={cn(
            "dispatch-activity-bar rounded-full origin-center will-change-transform",
            "bg-[linear-gradient(to_top,hsl(var(--status-blocked)),hsl(var(--status-waiting)),hsl(var(--status-working)),hsl(var(--status-done)))]",
            "saturate-[1.35] brightness-[1.05]",
            "motion-reduce:animate-none motion-reduce:scale-y-[0.55]",
            BAR_ANIMATION_CLASSES[i]
          )}
          style={{ width: bar, height: "100%" }}
        />
      ))}
    </div>
  );
}
