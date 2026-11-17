import type { Step } from "./contracts";

/**
 * What a turn's step was for, in the groups agents actually spend their
 * turns on. The groups and their order come from the prod stream (Nov 2026,
 * ~112k steps): Dispatch coordination 28%, reading code 23%, thinking 19%,
 * git and gh 12%, editing (incl. scripts) 6%, browser 5%, checks and tests
 * 2.5%, dev stack 1%, the rest other.
 */
export type ActivityCategory =
  | "dispatch"
  | "read"
  | "think"
  | "git"
  | "browser"
  | "edit"
  | "checks"
  | "dev"
  | "write"
  | "other";

const mix = (a: string, b: string) =>
  `color-mix(in oklch, hsl(var(${a})), hsl(var(${b})))`;

/**
 * A colour per group from the theme's status tokens. Themes carry about six
 * distinct hues, so three groups take an even mix of two to stay distinct.
 */
export const ACTIVITY_COLORS: Record<ActivityCategory, string> = {
  dispatch: "hsl(var(--status-merged))",
  read: "hsl(var(--status-done))",
  think: "hsl(var(--status-waiting))",
  git: mix("--status-blocked", "--status-waiting"),
  browser: mix("--status-done", "--status-working"),
  edit: "hsl(var(--status-blocked))",
  checks: "hsl(var(--status-working))",
  dev: mix("--status-working", "--status-waiting"),
  /** Progress text the agent wrote: the one neutral, in the text colour. */
  write: "hsl(var(--foreground))",
  other: "hsl(var(--status-idle))",
};

/** Drop `export X=…;`, `cd …&&`, `source …;` and quotes ahead of a command. */
function leadingCommand(title: string): string {
  return title
    .replace(/^["'\s]+/, "")
    .replace(/^((export|source|cd|nvm use)\s[^;&]*(;|&&)\s*)+/, "")
    .trim();
}

/**
 * The group a step falls in. Engines report most tools, MCP calls included,
 * as `execute` or `other`, so the title (the command or `mcp.server.tool`)
 * decides those.
 */
export function activityCategory(step: Step): ActivityCategory {
  switch (step.kind) {
    case "think":
    case "note":
      return "think";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "read":
    case "search":
      return "read";
  }
  const input = (step.detail as { input?: { command?: unknown } } | undefined)
    ?.input;
  const command =
    typeof input?.command === "string" ? input.command : (step.label ?? "");
  const title = leadingCommand(command);
  if (/^mcp(\.|__)dispatch(\.|__)repo_dev_/.test(title)) return "dev";
  if (/^mcp(\.|__)dispatch/.test(title)) return "dispatch";
  if (/^mcp(\.|__)playwright/.test(title)) return "browser";
  if (/^mcp/.test(title)) return "other";
  if (/^(git|gh)\b/.test(title)) return "git";
  if (/^(python3?|node|bun|perl|apply_patch)\b|^sed -i/.test(title))
    return "edit";
  if (
    /^(sed|cat|rg|grep|tail|head|ls|nl|wc|find|pwd|tree|stat|jq)\b/.test(title)
  )
    return "read";
  if (
    /^(pnpm|npm|npx|yarn|vitest|tsc|prettier|eslint|tsx|pytest|cargo|go)\b/.test(
      title
    )
  )
    return "checks";
  if (/^(curl|docker|psql|\.\/bin\/dispatch-dev|ps|kill|lsof)\b/.test(title))
    return "dev";
  return step.kind === "fetch" ? "browser" : "other";
}
