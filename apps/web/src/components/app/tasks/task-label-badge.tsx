import type { TaskLabel } from "../../../../../server/src/tasks/types";
import { Chip } from "@/components/ui/chip";
import { StatusDot } from "@/components/ui/status-dot";
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
    <Chip size="sm" title={label.name} className="max-w-[min(8rem,100%)]">
      <StatusDot
        color={
          legacyColors[label.color] ??
          (isHexColor(label.color) ? label.color : legacyColors.gray)
        }
      />
      <span className="min-w-0 truncate">{label.name}</span>
    </Chip>
  );
}
