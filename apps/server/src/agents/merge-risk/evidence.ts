/**
 * Bounded, structured evidence for a merge-risk decision. Built from data the
 * server already holds (PR metadata, changed paths, ownership map, review
 * blocks, CI rollup); never from tool output, raw diffs, or credentials. The
 * same builder serves the live trigger and the offline backfill so fixtures
 * match production payloads byte for byte.
 */
import type { CodeownersConfig } from "../../personas/codeowners.js";
import { resolveCodeowners } from "../../personas/codeowners.js";
import { isTestFile } from "../../shared/git/test-files.js";

export const MERGE_RISK_EVIDENCE_LIMIT = 12 * 1024;

export type MergeRiskFile = {
  path: string;
  additions?: number;
  deletions?: number;
  /** GitHub-style status; `removed` counts as a deletion. */
  status?: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
};

export type MergeRiskFinding = {
  title: string;
  severity: string;
  status: "open" | "fixed" | "dismissed";
  path?: string;
  note?: string;
};

export type MergeRiskReview = {
  reviewer: string;
  summary: string;
  findings: MergeRiskFinding[];
};

export type MergeRiskCi = {
  status: "passing" | "failing" | "pending" | "none" | "unknown";
  total: number;
  passed: number;
  failed: number;
  pending: number;
};

export type MergeRiskInput = {
  pullRequest: {
    number: number;
    title: string;
    body: string;
    baseRef: string;
    headRef: string;
    additions: number;
    deletions: number;
  };
  files: MergeRiskFile[];
  owners?: CodeownersConfig | null;
  briefing?: string;
  reviews: MergeRiskReview[];
  ci: MergeRiskCi | null;
};

export type MergeRiskFlags = {
  migrations: number;
  tests: number;
  docs: number;
  ci_config: number;
  dependencies: number;
  deletions: number;
};

export type MergeRiskEvidence = {
  pull_request: {
    number: number;
    title: string;
    description: string;
    base: string;
    head: string;
    additions: number;
    deletions: number;
    files_changed: number;
  };
  change_summary: {
    subsystems: Record<string, number>;
    uncovered_files: number;
    flags: MergeRiskFlags;
    non_test_lines: { added: number; deleted: number };
  };
  files: string[];
  briefing: string;
  reviews: {
    reviewer: string;
    summary: string;
    findings: {
      severity: string;
      title: string;
      status: string;
      note: string;
    }[];
    /** Present when the byte budget dropped findings from this review. */
    omitted_findings?: number;
    omitted_open_findings?: number;
  }[];
  /** Present when the byte budget dropped whole reviews. */
  omitted_reviews?: number;
  ci: MergeRiskCi | { status: "unknown" };
};

const isMigration = (p: string) =>
  /(^|\/)migrations?\//.test(p) && /\.(sql|ts|js|py|rb|go)$/.test(p);
const isDocs = (p: string) =>
  /\.(md|mdx|rst|txt)$/i.test(p) || /(^|\/)docs?\//.test(p);
const isCiConfig = (p: string) =>
  /^\.github\/workflows\//.test(p) ||
  /(^|\/)\.(gitlab-ci|circleci|buildkite)/.test(p);
const isDependency = (p: string) =>
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.(toml|lock)|go\.(mod|sum)|requirements.*\.txt|pyproject\.toml|poetry\.lock|Gemfile(\.lock)?)$/.test(
    p
  );

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;
const clean = (text: string | undefined | null) =>
  (text ?? "").replace(/\r/g, "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "");

export function classifyFiles(
  files: MergeRiskFile[],
  owners: CodeownersConfig | null | undefined
) {
  const paths = [...new Set(files.map((f) => f.path))].sort();
  const plan = owners ? resolveCodeowners(owners, paths, "n/a") : null;
  const subsystems: Record<string, number> = {};
  for (const owner of plan?.owners ?? [])
    subsystems[owner.persona] = owner.files.length;
  const flags: MergeRiskFlags = {
    migrations: 0,
    tests: 0,
    docs: 0,
    ci_config: 0,
    dependencies: 0,
    deletions: 0,
  };
  const nonTest = { added: 0, deleted: 0 };
  const flagged = new Map<string, string[]>();
  for (const file of files) {
    const tags: string[] = [];
    if (isMigration(file.path)) (flags.migrations++, tags.push("migration"));
    if (isTestFile(file.path)) (flags.tests++, tags.push("test"));
    else {
      nonTest.added += file.additions ?? 0;
      nonTest.deleted += file.deletions ?? 0;
    }
    if (isDocs(file.path)) (flags.docs++, tags.push("docs"));
    if (isCiConfig(file.path)) (flags.ci_config++, tags.push("ci"));
    if (isDependency(file.path)) (flags.dependencies++, tags.push("deps"));
    if (file.status === "removed") (flags.deletions++, tags.push("deleted"));
    flagged.set(file.path, tags);
  }
  return {
    subsystems,
    uncoveredFiles: plan ? plan.uncoveredFiles.length : paths.length,
    flags,
    nonTest,
    lines: files.map((file) => {
      const tags = flagged.get(file.path) ?? [];
      const counts =
        file.additions !== undefined || file.deletions !== undefined
          ? ` (+${file.additions ?? 0}/-${file.deletions ?? 0})`
          : "";
      return `${file.path}${counts}${tags.length ? ` [${tags.join(",")}]` : ""}`;
    }),
  };
}

export function buildMergeRiskEvidence(
  input: MergeRiskInput,
  limit = MERGE_RISK_EVIDENCE_LIMIT
): MergeRiskEvidence {
  const classified = classifyFiles(input.files, input.owners);
  const budgets = {
    description: 2000,
    briefing: 1500,
    summary: 900,
    note: 300,
    title: 160,
    files: 80,
    reviews: 10,
    findings: 15,
  };
  const build = (): MergeRiskEvidence => ({
    pull_request: {
      number: input.pullRequest.number,
      title: clip(clean(input.pullRequest.title), 200),
      description: clip(clean(input.pullRequest.body), budgets.description),
      base: input.pullRequest.baseRef,
      head: input.pullRequest.headRef,
      additions: input.pullRequest.additions,
      deletions: input.pullRequest.deletions,
      files_changed: input.files.length,
    },
    change_summary: {
      subsystems: classified.subsystems,
      uncovered_files: classified.uncoveredFiles,
      flags: classified.flags,
      non_test_lines: classified.nonTest,
    },
    files:
      classified.lines.length > budgets.files
        ? [
            ...classified.lines.slice(0, budgets.files),
            `… ${classified.lines.length - budgets.files} more files`,
          ]
        : classified.lines,
    briefing: clip(clean(input.briefing), budgets.briefing),
    reviews: input.reviews.slice(0, budgets.reviews).map((review) => ({
      reviewer: clip(clean(review.reviewer), 80),
      summary: clip(clean(review.summary), budgets.summary),
      findings: review.findings.slice(0, budgets.findings).map((finding) => ({
        severity: finding.severity,
        title: clip(clean(finding.title), budgets.title),
        status: finding.status,
        note: clip(clean(finding.note), budgets.note),
      })),
      ...(review.findings.length > budgets.findings
        ? {
            omitted_findings: review.findings.length - budgets.findings,
            omitted_open_findings: review.findings
              .slice(budgets.findings)
              .filter((f) => f.status === "open").length,
          }
        : {}),
    })),
    ...(input.reviews.length > budgets.reviews
      ? { omitted_reviews: input.reviews.length - budgets.reviews }
      : {}),
    ci: input.ci ?? { status: "unknown" },
  });
  const size = (value: MergeRiskEvidence) =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  // Shrink in stages until the payload fits: free text first, then the file
  // list, then finding and review detail (always leaving omitted counts), and
  // finally every free-text field. Structured counts and the CI summary are
  // never dropped, so the final stage always fits any sane limit.
  const stages: Array<() => void> = [
    () => {
      budgets.description = Math.floor(budgets.description / 2);
      budgets.briefing = Math.floor(budgets.briefing / 2);
      budgets.summary = Math.floor(budgets.summary / 2);
      budgets.note = Math.floor(budgets.note / 2);
    },
    () => {
      budgets.description = Math.floor(budgets.description / 2);
      budgets.briefing = Math.floor(budgets.briefing / 2);
      budgets.note = Math.floor(budgets.note / 2);
      budgets.files = 40;
    },
    () => {
      budgets.files = 20;
      budgets.note = 0;
      budgets.findings = 8;
    },
    () => {
      budgets.files = 10;
      budgets.title = 80;
      budgets.findings = 4;
      budgets.summary = Math.min(budgets.summary, 240);
    },
    () => {
      budgets.findings = 2;
      budgets.reviews = 6;
      budgets.description = Math.min(budgets.description, 300);
      budgets.briefing = 0;
    },
    () => {
      budgets.files = 0;
      budgets.title = 40;
      budgets.reviews = 3;
      budgets.summary = Math.min(budgets.summary, 120);
    },
    () => {
      budgets.findings = 0;
      budgets.description = 0;
    },
    () => {
      budgets.reviews = 1;
      budgets.summary = 0;
    },
    () => {
      budgets.reviews = 0;
    },
  ];
  let evidence = build();
  for (const stage of stages) {
    if (size(evidence) <= limit) break;
    stage();
    evidence = build();
  }
  return evidence;
}
