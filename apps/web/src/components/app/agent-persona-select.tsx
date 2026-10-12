import { useId } from "react";
import { useTaskPersonas } from "@/hooks/use-task-personas";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AgentPersonaSelect({
  cwd,
  value,
  onChange,
}: {
  cwd: string;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const id = useId();
  const { data, isLoading, isError, isSuccess } = useTaskPersonas(cwd);
  const personas = data?.personas ?? [];
  const selected = personas.find((p) => p.slug === value);
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        Persona <span className="text-muted-foreground/70">(optional)</span>
      </label>
      <Select
        value={value ?? "__none__"}
        onValueChange={(next) => {
          // Radix's hidden native select can emit an empty value while
          // repository-specific options change. Only explicit choices count.
          if (next) onChange(next === "__none__" ? null : next);
        }}
      >
        <SelectTrigger id={id} aria-label="Persona">
          <SelectValue placeholder="No persona" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">No persona</SelectItem>
          {(!cwd.trim() || isLoading || isError || !personas.length) && (
            <SelectItem value="__status__" disabled>
              {!cwd.trim()
                ? "Choose a directory first"
                : isLoading
                  ? "Loading personas…"
                  : isError
                    ? "Could not load personas"
                    : "No task personas in this directory"}
            </SelectItem>
          )}
          {data?.warnings?.length ? (
            <SelectItem
              value="__warnings__"
              disabled
              title={data.warnings.join("\n")}
            >
              Some persona files could not be loaded
            </SelectItem>
          ) : null}
          {value && !selected ? (
            <SelectItem value={value}>
              {value}
              {isSuccess ? " (unavailable)" : ""}
            </SelectItem>
          ) : null}
          {personas.map((p) => (
            <SelectItem key={p.slug} value={p.slug}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
