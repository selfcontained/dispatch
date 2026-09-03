import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
} from "lucide-react";
import { Markdown } from "@/components/ui/markdown";
import type { AssistedUpdateMetadata } from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

function checkName(
  c: AssistedUpdateMetadata["requiredChecks"][number]
): string {
  return typeof c === "string" ? c : c.name;
}

type AssistedUpdateGateProps = {
  tag: string;
  metadata: AssistedUpdateMetadata;
  /** True when the release is mode=required for the current install. */
  required: boolean;
};

/**
 * Informational card describing the release's declared assisted-update
 * metadata (instructions, required checks, rollback guidance). Shown when the
 * release is `mode=required` or `mode=recommended`. The action sits in the
 * unified split button rendered by UpdatesSection — this card is context.
 */
export function AssistedUpdateGate({
  tag,
  metadata,
  required,
}: AssistedUpdateGateProps): JSX.Element {
  const [instructionsOpen, setInstructionsOpen] = useState(true);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const checks = metadata.requiredChecks.map(checkName);

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-lg border p-4",
        required
          ? "border-amber-500/40 bg-amber-500/[0.06]"
          : "border-blue-500/30 bg-blue-500/[0.06]"
      )}
    >
      <div className="flex items-start gap-2">
        {required ? (
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
        )}
        <div className="flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {required
              ? "Agent-assisted update required"
              : "Agent-assisted update recommended"}
          </div>
          <div className="text-sm font-semibold text-foreground">
            {metadata.title}
          </div>
          <div className="font-mono text-xs text-muted-foreground">{tag}</div>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{metadata.summary}</p>

      {metadata.instructions && (
        <div>
          <button
            onClick={() => setInstructionsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            {instructionsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Instructions
          </button>
          {instructionsOpen && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-white/[0.12] bg-white/[0.04] p-3 text-sm text-muted-foreground">
              <Markdown>{metadata.instructions}</Markdown>
            </div>
          )}
        </div>
      )}

      {checks.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
            Required checks
          </div>
          <ul className="flex flex-col gap-0.5 text-sm">
            {checks.map((c) => (
              <li
                key={c}
                className="flex items-center gap-2 font-mono text-xs text-muted-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                {c}
              </li>
            ))}
          </ul>
        </div>
      )}

      {metadata.rollbackGuidance && (
        <div>
          <button
            onClick={() => setRollbackOpen((v) => !v)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            {rollbackOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Rollback guidance
          </button>
          {rollbackOpen && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded border border-white/[0.12] bg-white/[0.04] p-3 text-sm text-muted-foreground">
              <Markdown>{metadata.rollbackGuidance}</Markdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
