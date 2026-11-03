import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Effort } from "@dispatch/shared";
import { AgentEffortSelect } from "./agent-effort-select";
import { api } from "@/lib/api";

type EffortSetting = { effort: Effort | null };
const queryKey = ["settings", "effort"];
export function EffortSettings(): JSX.Element {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: () => api<EffortSetting>("/api/v1/app/settings/effort"),
  });
  const save = useMutation({
    mutationFn: (effort: Effort | null) =>
      api<EffortSetting>("/api/v1/app/settings/effort", {
        method: "POST",
        body: JSON.stringify({ effort }),
      }),
    onSuccess: (data) => client.setQueryData(queryKey, data),
  });
  return (
    <div className="max-w-lg space-y-3 p-6">
      <h3 className="text-sm font-medium">Default reasoning effort</h3>
      <p className="text-sm text-muted-foreground">
        Used for new Claude and Codex agents when the launch, trigger and
        template do not choose an effort. OpenCode uses its own settings. Clear
        this default to use the CLI’s settings files.
      </p>
      {query.data ? (
        <fieldset disabled={save.isPending}>
          <AgentEffortSelect
            value={query.data.effort}
            onChange={(effort) => save.mutate(effort)}
            agentType="claude"
            id="settings-default-effort"
            inheritLabel="CLI settings (no default)"
          />
        </fieldset>
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {query.error || save.error ? (
        <p role="alert" className="text-sm text-destructive">
          {(query.error ?? save.error)?.message}
        </p>
      ) : null}
    </div>
  );
}
