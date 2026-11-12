import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

/**
 * PR-check observations persist only as the server's bounded Markdown notice
 * (apps/server/src/agents/pull-request-check-notice.ts). Parse that shape to
 * show results inline; anything unrecognised falls back to the text verbatim.
 */
export interface ParsedCheckNotice {
  /** The PR the notice names, e.g. "#1439", linked when the server linked it. */
  pr?: { number: string; url?: string };
  status?: string;
  counts: { count: number; label: string }[];
  checks: { name: string; url?: string; outcome: string; detail?: string }[];
  more?: number;
}

const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
// The server percent-encodes raw <>\ (already valid in an href) and writes
// & as &amp;; only the latter needs undoing.
const decodeUrl = (s: string) => s.replaceAll("&amp;", "&");
const safeUrl = (s: string) => {
  try {
    const url = new URL(s);
    return ["https:", "http:"].includes(url.protocol) ? s : undefined;
  } catch {
    return undefined;
  }
};

export function parseCheckNotice(text: string): ParsedCheckNotice | undefined {
  const lines = text.split("\n").filter((l) => l.trim());
  // Header: "<PR link> — <Status> · 3 passed, 1 failed, 2 pending"
  const header = lines[0]?.match(/^(\S.*) — ([A-Za-z]+) · (.+)$/);
  if (!header) return;
  const prRef = header[1].match(/^(?:\[#(\d+)\]\(<([^>]*)>\)|#(\d+))$/);
  const prUrl = prRef?.[2] ? safeUrl(decodeUrl(prRef[2])) : undefined;
  const counts: ParsedCheckNotice["counts"] = [];
  for (const part of header[3].split(", ")) {
    const m = part.match(/^(\d+) (.+)$/);
    if (!m) return;
    counts.push({ count: Number(m[1]), label: unescape(m[2]) });
  }
  const parsed: ParsedCheckNotice = {
    ...(prRef
      ? {
          pr: {
            number: prRef[1] ?? prRef[3],
            ...(prUrl ? { url: prUrl } : {}),
          },
        }
      : {}),
    status: header[2],
    counts,
    checks: [],
  };
  for (const line of lines.slice(1)) {
    if (/· Info only; no action authorized\.$/.test(line)) continue;
    const more = line.match(/^- \+(\d+) more$/);
    if (more) {
      parsed.more = Number(more[1]);
      continue;
    }
    const item = line.match(/^- (.+) — (passed|failed)(?: · (.+))?$/);
    if (!item) return;
    const linked = item[1].match(/^\[(.*)\]\(<([^>]*)>\)$/);
    const url = linked ? safeUrl(decodeUrl(linked[2])) : undefined;
    parsed.checks.push({
      name: unescape(linked ? linked[1] : item[1]),
      ...(url ? { url } : {}),
      outcome: item[2],
      ...(item[3] ? { detail: item[3] } : {}),
    });
  }
  return parsed;
}

const tone = (label: string) =>
  label === "failed"
    ? "text-destructive"
    : label === "passed"
      ? "text-status-working"
      : label === "pending"
        ? "text-status-waiting"
        : "text-muted-foreground";

export function PullRequestCheckResults({
  text,
  notice,
}: {
  text: string;
  /** Pass when already parsed; undefined means the shape was unrecognised. */
  notice: ParsedCheckNotice | undefined;
}) {
  if (!text.trim()) return null;
  if (!notice)
    return (
      <div className="mt-2 break-words font-sans text-sm leading-relaxed">
        <Markdown>{text}</Markdown>
      </div>
    );
  // Totals describe the whole snapshot; rows are the bounded set of checks the
  // notice names (failures first), so they add names and links, not counts.
  const checks = [...notice.checks].sort(
    (a, b) => Number(b.outcome === "failed") - Number(a.outcome === "failed")
  );
  return (
    <div className="mt-2 space-y-2 font-sans">
      {notice.counts.length > 0 && (
        <p
          className="flex flex-wrap gap-x-3 gap-y-1 text-xs"
          aria-label="Check totals"
        >
          {notice.counts.map(({ count, label }) => (
            <span key={label} className={cn("font-medium", tone(label))}>
              {count} {label}
            </span>
          ))}
        </p>
      )}
      {checks.length > 0 && (
        <div>
          <ul className="space-y-1 text-sm" aria-label="Check results">
            {checks.map((check, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                    check.outcome === "failed"
                      ? "bg-destructive"
                      : "bg-status-working"
                  )}
                />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {check.url ? (
                    <a
                      href={check.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline decoration-border underline-offset-4 focus-visible:outline-ring"
                    >
                      {check.name}
                    </a>
                  ) : (
                    check.name
                  )}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs",
                    check.outcome === "failed"
                      ? "font-medium text-destructive"
                      : "text-muted-foreground"
                  )}
                >
                  {check.outcome}
                  {check.detail ? ` · ${check.detail}` : ""}
                </span>
              </li>
            ))}
            {notice.more ? (
              <li className="pl-3.5 text-xs text-muted-foreground">
                +{notice.more} more
              </li>
            ) : null}
          </ul>
        </div>
      )}
    </div>
  );
}
