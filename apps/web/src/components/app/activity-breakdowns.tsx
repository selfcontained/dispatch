import { shortModelName } from "@/components/app/activity-chart-utils";
import { Meter } from "@/components/ui/dashboard";
import { formatCount, formatTokenCount, shortProjectName } from "@/lib/format";
import type { TokenByModel, TokenByProject } from "@/hooks/use-activity";

// Every bar on the page is total tokens, so every bar is the one colour.
const TOTAL_TOKENS_COLOR = "hsl(var(--chart-5))";

// ── Per-model breakdown ───────────────────────────────────────────

export function ModelBreakdown({ data }: { data: TokenByModel[] }) {
  if (data.length === 0) return null;
  const max = Math.max(
    ...data.map(
      (m) =>
        m.total_input +
        m.total_cache_creation +
        m.total_cache_read +
        m.total_output
    )
  );

  return (
    <div className="space-y-3">
      {data.map((m) => {
        const total =
          m.total_input +
          m.total_cache_creation +
          m.total_cache_read +
          m.total_output;
        return (
          <Meter
            key={m.model}
            label={shortModelName(m.model)}
            value={`${formatTokenCount(total)} · ${formatCount(m.sessions, "session")}`}
            ratio={max > 0 ? total / max : 0}
            color={TOTAL_TOKENS_COLOR}
          />
        );
      })}
    </div>
  );
}

// ── Per-project breakdown ─────────────────────────────────────────

export function ProjectBreakdown({ data }: { data: TokenByProject[] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((p) => p.total_input + p.total_output));
  return (
    <div className="space-y-3">
      {data.map((p) => (
        <Meter
          key={p.project_dir}
          label={shortProjectName(p.project_dir)}
          value={`${formatTokenCount(p.total_input + p.total_output)} tokens`}
          ratio={max > 0 ? (p.total_input + p.total_output) / max : 0}
          color={TOTAL_TOKENS_COLOR}
        />
      ))}
    </div>
  );
}
