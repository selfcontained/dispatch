import { useTaskPersonas } from "@/hooks/use-task-personas";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/ui/field";

export function AgentPersonaSelect({
  cwd,
  projectId,
  value,
  onChange,
}: {
  cwd: string;
  projectId?: string | null;
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const { data, isLoading, isError, isSuccess } = useTaskPersonas(
    cwd,
    projectId
  );
  const personas = data?.personas ?? [];
  const selected = personas.find((p) => p.slug === value);
  return (
    <Field label="Persona" optional>
      <Select
        value={value ?? "__none__"}
        onValueChange={(next) => {
          // Radix's hidden native select can emit an empty value while
          // repository-specific options change. Only explicit choices count.
          if (next) onChange(next === "__none__" ? null : next);
        }}
      >
        <SelectTrigger
          aria-label="Persona"
          className={!value ? "text-muted-foreground" : undefined}
        >
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__" className="text-muted-foreground">
            None
          </SelectItem>
          {(!cwd.trim() || isLoading || isError || !personas.length) && (
            <SelectItem value="__status__" disabled>
              {!cwd.trim()
                ? "Choose a directory first"
                : isLoading || data?.refreshing
                  ? "Loading personas…"
                  : isError
                    ? "Couldn’t load personas"
                    : "No task personas available"}
            </SelectItem>
          )}
          {data?.warnings?.length ? (
            <SelectItem
              value="__warnings__"
              disabled
              className="max-w-[min(24rem,80vw)] whitespace-normal"
            >
              {data.warnings[0]}
            </SelectItem>
          ) : null}
          {value && !selected ? (
            <SelectItem value={value}>
              {value}
              {isSuccess && !data?.refreshing ? " (unavailable)" : ""}
            </SelectItem>
          ) : null}
          {personas.map((p) => (
            <SelectItem key={p.slug} value={p.slug}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
