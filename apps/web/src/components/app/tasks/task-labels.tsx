import { useState } from "react";
import type { TaskLabel } from "../../../../../server/src/tasks/types";
import { useTaskBoard } from "@/hooks/use-tasks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
const colors: Record<string, string> = {
  gray: "bg-slate-100 text-slate-900",
  red: "bg-red-100 text-red-900",
  orange: "bg-orange-100 text-orange-900",
  green: "bg-green-100 text-green-900",
  blue: "bg-blue-100 text-blue-900",
  purple: "bg-purple-100 text-purple-900",
};
export function TaskLabels({ labels = [] }: { labels?: TaskLabel[] }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {labels.slice(0, 3).map((label) => (
        <Badge
          key={label.name}
          className={`max-w-32 truncate ${colors[label.color]}`}
          title={label.name}
        >
          {label.name}
        </Badge>
      ))}
      {labels.length > 3 && (
        <Badge
          title={labels
            .slice(3)
            .map((l) => l.name)
            .join(", ")}
        >
          +{labels.length - 3}
        </Badge>
      )}
    </div>
  );
}
export function TaskLabelPicker({
  projectId,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string;
  value: TaskLabel[];
  onChange: (labels: TaskLabel[]) => void;
  disabled?: boolean;
}) {
  const { data } = useTaskBoard(projectId);
  const [name, setName] = useState("");
  const [color, setColor] = useState("gray");
  const existing = data?.labels ?? [];
  const matching = existing.filter((l) =>
    l.name.toLowerCase().includes(name.trim().toLowerCase())
  );
  const add = (label: TaskLabel) => {
    if (
      value.length < 20 &&
      !value.some((l) => l.name.toLowerCase() === label.name.toLowerCase())
    )
      onChange([...value, label]);
    setName("");
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="default"
          disabled={disabled}
          aria-label="Edit labels"
        >
          Labels{value.length ? ` (${value.length})` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3">
        <div className="flex flex-wrap gap-1">
          {value.map((l) => (
            <Button
              type="button"
              key={l.name}
              variant="default"
              size="sm"
              onClick={() => onChange(value.filter((v) => v.name !== l.name))}
              aria-label={`Remove label ${l.name}`}
            >
              {l.name} ×
            </Button>
          ))}
        </div>
        <Input
          aria-label="Label name"
          placeholder="Find or create label"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="max-h-40 overflow-auto">
          {matching.map((l) => (
            <Button
              type="button"
              className="w-full justify-start"
              variant="ghost"
              key={l.name}
              disabled={value.some((v) => v.name === l.name)}
              onClick={() => add(l)}
            >
              <TaskLabels labels={[l]} />
            </Button>
          ))}
        </div>
        {name.trim() &&
          !existing.some(
            (l) => l.name.toLowerCase() === name.trim().toLowerCase()
          ) && (
            <>
              <Select value={color} onValueChange={setColor}>
                <SelectTrigger aria-label="Label color">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(colors).map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                disabled={
                  value.length >= 20 ||
                  [...name].some(
                    (char) =>
                      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
                  )
                }
                onClick={() => add({ name: name.trim(), color })}
              >
                Create “{name.trim()}”
              </Button>
            </>
          )}
        <p className="text-xs text-muted-foreground">
          Up to 20 labels, 40 characters each. Existing labels keep their
          project color.
        </p>
      </PopoverContent>
    </Popover>
  );
}
