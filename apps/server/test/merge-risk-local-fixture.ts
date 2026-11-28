/**
 * Recorded GitHub evidence for merge-risk parity tests: a fake `gh` that
 * answers main's exact local commands. Never calls GitHub.
 */
import type { AgentPullRequest } from "@dispatch/shared";
import type { CommandRunner } from "../src/shared/lib/run-command.js";
import { mapPullRequestChecks } from "../src/agents/pull-request-reader.js";

export const URL_ = "https://github.com/acme/widgets/pull/9";
export const HEAD = "1".repeat(40);
export const BASE = "2".repeat(40);

const big = Array.from(
  { length: 300 },
  (_, i) => `+const line${i} = ${i}; // padding so the hunk is clipped`
).join("\n");

const files = [
  { path: "src/auth/login.ts", additions: 40, deletions: 3 },
  { path: "db/migrations/0042_add_users.sql", additions: 12, deletions: 0 },
  { path: "src/auth/login.test.ts", additions: 25, deletions: 1 },
  { path: "pnpm-lock.yaml", additions: 900, deletions: 400 },
  { path: ".env.production", additions: 1, deletions: 0 },
  { path: "docs/auth.md", additions: 4, deletions: 0 },
  { path: "src/ui/Button.tsx", additions: 2, deletions: 2 },
];

export const PR_VIEW = {
  number: 9,
  title: "Harden login",
  body: "Checks the session token before redirecting.\n\nCloses #4.",
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  additions: 984,
  deletions: 406,
  baseRefName: "main",
  headRefName: "harden-login",
  headRefOid: HEAD,
  files,
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "test",
      status: "COMPLETED",
      conclusion: "SUCCESS",
    },
  ],
};

export const COMPARE = files.map((f, i) => ({
  ...f,
  ...(f.path === "pnpm-lock.yaml"
    ? {}
    : {
        patch:
          i === 0
            ? `@@ -1,3 +1,40 @@\n${big}\n@@ -90,2 +127,5 @@\n+tail();`
            : `@@ -0,0 +1,${f.additions} @@\n+change in ${f.path}`,
      }),
}));

export type GhCall = { args: string[]; options: unknown };

/** main's local `gh` commands, answered from the recording above. */
export function fixtureGh() {
  const calls: GhCall[] = [];
  const run: CommandRunner = async (bin, args, options) => {
    if (bin !== "gh") throw new Error(`unexpected ${bin}`);
    calls.push({ args: [...args], options });
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
    if (args[0] === "pr" && args[1] === "view")
      return ok(JSON.stringify(PR_VIEW));
    if (args[0] === "api" && args[1] === "repos/acme/widgets/pulls/9")
      return ok(`${BASE}\n`);
    if (
      args[0] === "api" &&
      args[1] === `repos/acme/widgets/compare/${BASE}...${HEAD}`
    )
      return ok(JSON.stringify(COMPARE));
    return { exitCode: 1, stdout: "", stderr: "not recorded" };
  };
  return { run, calls };
}

export function fixturePr(
  patch: Partial<AgentPullRequest> = {}
): AgentPullRequest {
  return {
    url: URL_,
    title: "Harden login",
    status: "Open",
    ci: mapPullRequestChecks(HEAD, PR_VIEW.statusCheckRollup),
    ...patch,
  };
}

export const providerAnswers = () =>
  Response.json({
    answers: [
      {
        type: "score",
        name: "change_risk",
        score: 0.6,
        confidence: 0.9,
        probabilities: [],
      },
      { type: "predicate", name: "review_adequate", probability: 0.7 },
      { type: "predicate", name: "description_matches_diff", probability: 0.8 },
      { type: "predicate", name: "new_user_facing_surface", probability: 0.2 },
      {
        type: "choice",
        name: "needs_human",
        choice: "routine",
        confidence: 0.95,
        probabilities: [
          { value: "routine", probability: 0.9 },
          { value: "human_review", probability: 0.1 },
          { value: "abstain", probability: 0 },
        ],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
  });

export const explanationReply = () =>
  Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Because migrations." }],
      },
    ],
  });
