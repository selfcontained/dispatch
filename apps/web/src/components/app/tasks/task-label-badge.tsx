import type { TaskLabel } from "../../../../../server/src/tasks/types";
import { Badge } from "@/components/ui/badge";
import { isHexColor } from "../color-picker";
const legacyColors: Record<string, string> = {
  gray: "#a5aab7",
  red: "#ef6c57",
  orange: "#dda348",
  green: "#74b85c",
  blue: "#649feb",
  purple: "#9575ed",
};
/** The single visual treatment for a project label throughout task UI. */
export function TaskLabelBadge({ label }: { label: TaskLabel }) {
  return (
    <Badge
      title={label.name}
      className="min-w-0 max-w-[min(8rem,100%)] gap-1.5 rounded border-border/60 bg-muted/30 px-1.5 py-0 text-[11px] font-normal normal-case tracking-normal text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{
          backgroundColor:
            legacyColors[label.color] ??
            (isHexColor(label.color) ? label.color : legacyColors.gray),
        }}
      />
      <span className="min-w-0 truncate">{label.name}</span>
    </Badge>
  );
}
