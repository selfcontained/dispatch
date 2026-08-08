import { Input } from "@/components/ui/input";

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
  const listId = "create-agent-model-suggestions";
  return (
    <div className="space-y-1">
      <label
        className="text-sm text-muted-foreground"
        htmlFor="create-agent-model"
      >
        Model
      </label>
      <Input
        id="create-agent-model"
        data-testid="create-agent-model"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        placeholder={loading ? "Loading suggestions…" : "Default (CLI setting)"}
        list={loading ? undefined : listId}
        disabled={loading}
      />
      {!loading ? (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option.id} value={option.id} label={option.label} />
          ))}
        </datalist>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Suggested IDs are shown as you type. Your provider CLI validates custom
        model availability.
      </p>
    </div>
  );
}
