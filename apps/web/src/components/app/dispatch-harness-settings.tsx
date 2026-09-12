import { ToggleSettingCard } from "@/components/app/toggle-setting-card";
import { useDispatchHarnessSetting } from "@/hooks/use-dispatch-harness-enabled";

/**
 * Toggle for the Dispatch Harness agent type. This is the only place the
 * harness is turned on: it is deliberately not a checkbox in the agent-type
 * list, because that list is persisted server-side and two switches for one
 * type could disagree.
 *
 * Server-owned like the other flags (GET on mount, POST on an explicit
 * toggle), and it lives in the React Query cache the type pickers read, so
 * flipping it here adds or removes the type from the create dialog without a
 * reload. See `useDispatchHarnessSetting` for the optimistic write.
 */
export function DispatchHarnessSettings(): JSX.Element {
  const { enabled, error, setEnabled } = useDispatchHarnessSetting();

  return (
    <ToggleSettingCard
      eyebrow="Dispatch Harness"
      description={
        <>
          Dispatch&apos;s own view over Claude Code, Codex, Gemini CLI, or
          OpenCode. Needs the engine&apos;s CLI installed and logged in on the
          server (see the runbook&apos;s Dispatch Harness engines table).
        </>
      }
      label="Dispatch Harness (beta)"
      hint="Turning this off stops new dispatch agents from being created and leaves the ones already running alone."
      testId="dispatch-harness-toggle"
      checked={enabled}
      onCheckedChange={setEnabled}
      error={error}
    />
  );
}
