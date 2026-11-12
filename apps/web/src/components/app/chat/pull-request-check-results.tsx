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

const statusTone = (status: string) =>
  status === "Failing"
    ? "text-destructive"
    : status === "Passing"
      ? "text-status-working"
      : status === "Pending"
        ? "text-status-waiting"
        : "text-muted-foreground";

/**
 * One summary line, the same on every check card: status, then counts by
 * status from the snapshot. Named check rows are left out on purpose: the
 * notice only names a bounded set of newly finished checks, so rows would
 * appear on some cards and not others.
 */
export function PullRequestCheckResults({
  text,
  notice,
  status,
}: {
  text: string;
  /** Pass when already parsed; undefined means the shape was unrecognised. */
  notice: ParsedCheckNotice | undefined;
  status?: string;
}) {
  if (text.trim() && !notice)
    return (
      <div className="mt-1 break-words font-sans text-sm leading-relaxed">
        <Markdown>{text}</Markdown>
      </div>
    );
  const counts = notice?.counts ?? [];
  return (
    <p
      className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 font-sans text-xs"
      aria-label="Check summary"
    >
      {status ? (
        <span className={cn("font-semibold", statusTone(status))}>
          {status}
        </span>
      ) : null}
      {counts.map(({ count, label }, i) => (
        <span key={label} className="whitespace-nowrap">
          {status || i > 0 ? (
            <span aria-hidden className="text-muted-foreground">
              ·{" "}
            </span>
          ) : null}
          <span className={tone(label)}>
            {count} {label}
          </span>
        </span>
      ))}
      {!status && !counts.length ? (
        <span className="text-muted-foreground">No check results</span>
      ) : null}
    </p>
  );
}
