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
};

export function AgentModelSelect({
  value,
  options,
  onChange,
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
        value={value ?? "__default__"}
        onValueChange={(nextValue) =>
          onChange(nextValue === "__default__" ? null : nextValue)
        }
      >
        <SelectTrigger id="create-agent-model" data-testid="create-agent-model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">Default</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
