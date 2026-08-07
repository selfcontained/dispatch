import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type AgentModelOption = { id: string; label: string };

type AgentModelSelectProps = {
  value: string | null;
  options: readonly AgentModelOption[];
  onChange: (model: string | null) => void;
  loading?: boolean;
};

export function AgentModelSelect({
  value,
  options,
  onChange,
  loading = false,
}: AgentModelSelectProps): JSX.Element {
  return (
    <div className="space-y-1">
      <label
        className="text-sm text-muted-foreground"
        htmlFor="create-agent-model"
      >
        Model
      </label>
      <Select
        value={loading ? "__loading__" : (value ?? "__default__")}
        onValueChange={(nextValue) =>
          onChange(nextValue === "__default__" ? null : nextValue)
        }
      >
        <SelectTrigger
          id="create-agent-model"
          data-testid="create-agent-model"
          disabled={loading}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {loading ? (
            <SelectItem value="__loading__" disabled>
              Loading models…
            </SelectItem>
          ) : (
            <SelectItem value="__default__">Default (CLI setting)</SelectItem>
          )}
          {!loading &&
            options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}
