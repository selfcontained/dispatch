import { AlertTriangle } from "lucide-react";

/**
 * Stands in for the full-access checkbox where the agent type leaves no
 * choice.
 *
 * Every Dispatch Harness engine launches in its most permissive mode
 * (skip-permissions for Claude Code, agent-full-access for Codex, yolo for
 * Gemini CLI, auto-allow for OpenCode), so an unchecked box promised a
 * prompt before each command that never arrived. Shared by the create,
 * jobs and template forms so the three cannot drift apart.
 */
export function AlwaysFullAccessNote(): JSX.Element {
  return (
    <div
      className="flex items-start gap-3 rounded-md border border-status-waiting/35 bg-status-waiting/10 px-3 py-3 text-status-waiting md:col-span-2"
      data-testid="always-full-access-note"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="space-y-1">
        <span className="block text-sm font-medium">
          Dispatch Harness agents always run with full access
        </span>
        <span className="block text-xs opacity-90">
          Each engine launches in its most permissive mode, so there is nothing
          to turn off here.
        </span>
      </span>
    </div>
  );
}
