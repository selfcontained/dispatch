import { shortModelName } from "@/components/app/activity-chart-utils";
import { cn } from "@/lib/utils";
import { formatTokenCount, shortProjectName } from "@/lib/format";
import type { TokenByModel, TokenByProject } from "@/hooks/use-activity";

// ── Horizontal bar helper ──────────────────────────────────────────

function HorizontalBar({
  label,
  value,
  maxValue,
  color = "bg-emerald-500/70",
  sub,
}: {
  label: string;
  value: number;
  maxValue: number;
  color?: string;
  sub?: string;
}) {
  const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate text-foreground">{label}</span>
        <span className="ml-2 shrink-0 font-mono text-muted-foreground tabular-nums">
          {formatTokenCount(value)}
          {sub ? ` ${sub}` : ""}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted/60">
        <div
          className={cn("h-2 rounded-full transition-all", color)}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
    </div>
  );
}

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
          <HorizontalBar
            key={m.model}
            label={shortModelName(m.model)}
            value={total}
            maxValue={max}
            color="bg-chart-5"
            sub={`· ${m.sessions} session${m.sessions !== 1 ? "s" : ""}`}
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
    <div className="space-y-4">
      {data.map((p) => (
        <HorizontalBar
          key={p.project_dir}
          label={shortProjectName(p.project_dir)}
          value={p.total_input + p.total_output}
          maxValue={max}
          color="bg-chart-6"
          sub="tokens"
        />
      ))}
    </div>
  );
}
