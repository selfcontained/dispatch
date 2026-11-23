import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compareHistory,
  compareHits,
  countHits,
  historyErrors,
  scanSource,
} from "./check-runner-boundary.mjs";
import { restrictionHits } from "./runner-restrictions.mjs";

const app = "apps/server/src/";
const web = "apps/web/src/feature.tsx";
const protocol = "packages/runner-protocol/src/example.ts";

const violations = [
  [
    app + "unknown.ts",
    'import { remotePlacement as decode } from "@dispatch/runner-protocol"; decode(cwd);',
    "R1 placement call",
  ],
  [app + "unknown.ts", 'agent.cwd.startsWith("runner://")', "R1 locator"],
  [
    app + "db/migrations/example.sql",
    "SELECT cwd LIKE 'runner://%';",
    "R1 locator",
  ],
  [
    app + "unknown.ts",
    'const { runner: id } = placement; placement["runner"];',
    "R1 placement read",
  ],
  [app + "unknown.ts", "session.remote", "R1 placement read"],
  [
    app + "unknown.ts",
    'runnerDescription.id === "local"',
    "R1 runner ID comparison",
  ],
  [app + "unknown.ts", 'runnerId !== "office"', "R1 runner ID comparison"],
  [app + "unknown.ts", "placement.runner === LOCAL_RUNNER_ID", "R1 local ID"],
  [app + "unknown.ts", "directory.defaultPlacement()", "R1 placement call"],
  [
    app + "unknown.ts",
    'import { ideTarget } from "./runners/controller-machine.js";',
    "R1 controller-machine import",
  ],
  [
    app + "runners/controller-machine.ts",
    "export const isLocal = true;",
    "R1 controller-machine export",
  ],
  [
    app + "unknown.ts",
    'export { readFile } from "node:fs/promises";',
    "R2 host access",
  ],
  [
    app + "unknown.ts",
    'await import("node:worker_threads");',
    "R2 host access",
  ],
  [app + "unknown.ts", 'module.require("os");', "R2 host access"],
  [app + "unknown.ts", 'await import(prefix + "fs");', "R2 computed import"],
  [
    app + "unknown.ts",
    'await import("./shared/git/git-context.js");',
    "R2 host import",
  ],
  [
    app + "runners/directory.ts",
    'import { childProcessEnv } from "../shared/process/child-environment.js";',
    "R2 host import",
  ],
  [
    app + "runners/local.ts",
    'import { git } from "../shared/git/git-context.js";',
    "R2 host import",
  ],
  [app + "unknown.ts", 'Bun.spawn(["git", "status"]);', "R2 host access"],
  [app + "unknown.ts", 'Bun["file"](path);', "R2 host access"],
  [app + "unknown.ts", "const { spawn: exec } = Bun;", "R2 host access"],
  [app + "unknown.ts", 'process.getBuiltinModule("fs");', "R2 host access"],
  [
    app + "unknown.ts",
    'import { createRequire as load } from "node:module"; const req = load(import.meta.url); req("fs");',
    "R2 host access",
  ],
  [
    app + "unknown.ts",
    'new WebSocket("ws://127.0.0.1:9123/path");',
    "R2 host access",
  ],
  [
    app + "agents/local-runner.ts",
    "export function createLocalRunner() { return { requestSession, extra }; }",
    "R3 local method",
  ],
  [protocol, 'export type { Row } from "pg";', "R5 package import"],
  [
    protocol,
    'import "../../../apps/server/src/config.js";',
    "R5 package import",
  ],
  [protocol, 'import("fastify");', "R5 package import"],
  [
    app + "agents/remote/runner.ts",
    'import "../../server.js";',
    "R5 runner to Dispatch",
  ],
  [
    app + "unknown.ts",
    'import("@dispatch/runner/cli");',
    "R5 Dispatch to runner",
  ],
  [
    app + "unknown.ts",
    'import("@dispatch/runner-client/transport");',
    "R5 Dispatch to client transport",
  ],
  [
    web,
    'const runner = agent.runnerManaged ? "managed" : "external";',
    "R6 placement read",
  ],
  [
    web,
    'import { workspaceLocator } from "@dispatch/runner-protocol";',
    "R6 protocol value import",
  ],
];

for (const [file, source, kind] of violations) {
  test(`rejects ${kind} in ${source}`, () => {
    const hits = countHits(scanSource(file, source));
    assert.ok(
      hits.some((entry) => entry.kind === kind),
      JSON.stringify(hits)
    );
    assert.match(compareHits(hits, []).join("\n"), /New hit/);
  });
}

test("accepts clean sources and the controller's scoped host capabilities", () => {
  for (const [file, source] of [
    [
      app + "unknown.ts",
      'import type { Stats } from "node:fs"; const status = "local"; someClient.require(id);',
    ],
    [app + "db/migrate.ts", 'import { readFile } from "node:fs/promises";'],
    [app + "local-tls.ts", 'Bun.spawn(["openssl", "version"]);'],
    [
      app + "main.ts",
      'if (command === "agent-host") await import("@dispatch/runner/cli");',
    ],
    [app + "unknown.test.ts", 'await import("node:fs");'],
    [
      app + "runners/local.ts",
      'import { childProcessEnv } from "../shared/process/child-environment.js"; import { superviseRunner } from "@dispatch/runner-client/launcher";',
    ],
    [
      app + "main.ts",
      'if (process.argv[2] === "local-runner") await import("@dispatch/runner/cli");',
    ],
    [protocol, 'export * from "./index.js";'],
    [web, 'import type { Placement } from "@dispatch/runner-protocol";'],
  ]) {
    assert.deepEqual(compareHits(countHits(scanSource(file, source)), []), []);
  }
});

test("requires deleting stale entries and detects a higher count in the same file", () => {
  const file = app + "unknown.ts";
  const source = "remotePlacement(cwd);";
  const baseline = countHits(scanSource(file, source));
  assert.deepEqual(
    compareHits(countHits(scanSource(file, source)), baseline),
    []
  );
  assert.match(compareHits([], baseline).join("\n"), /Stale baseline/);
  assert.match(
    compareHits(countHits(scanSource(file, source.repeat(2))), baseline).join(
      "\n"
    ),
    /New hit/
  );
});

test("requires source and baseline to shrink together for a named restriction", () => {
  const read = () => 'return reject("runnerStorage")';
  const hits = countHits(restrictionHits(read));
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /^N3 /);
  assert.match(compareHits(hits, []).join("\n"), /New hit/);
  assert.match(
    compareHits(countHits(restrictionHits(() => undefined)), hits).join("\n"),
    /Stale baseline/
  );
});

test("ratchet allows only removals and count decreases", () => {
  const baseline = countHits(
    scanSource(app + "example.ts", "remotePlacement(cwd); remotePlacement(cwd)")
  );
  assert.deepEqual(
    compareHistory(baseline, [{ ...baseline[0], count: 1 }]),
    []
  );
  assert.deepEqual(compareHistory(baseline, []), []);
  for (const next of [
    [{ ...baseline[0], count: 3 }],
    [{ ...baseline[0], detail: "different" }],
    [{ ...baseline[0], task: "T99" }],
    undefined,
  ])
    assert.equal(compareHistory(baseline, next).length, 1);
});

test("the P7 runner release restriction is recorded only with the archive dialog restoration", () => {
  const file = "apps/web/src/components/app/delete-agent-dialog.tsx";
  const before = [
    { file, kind: "R6 locator", detail: "runner://", task: "T38", count: 1 },
    {
      file,
      kind: "R6 placement read",
      detail: "deleteTarget?.runnerManaged",
      task: "T38",
      count: 1,
    },
  ];
  const restriction = {
    file: "apps/server/src/agents/remote/session-supervisor.ts",
    kind: "R7 restriction",
    detail: "N35 Runner archive conditionally releases and defers to borrowers",
    task: "T20",
    count: 1,
  };
  assert.deepEqual(compareHistory(before, [restriction]), []);
  assert.equal(compareHistory([], [restriction]).length, 1);
  assert.equal(
    compareHistory(before, [{ ...restriction, count: 2 }]).length,
    1
  );
});

test("T09 records its in-process read fallback once, beside the adapter delegation", () => {
  const delegation = {
    file: app + "runners/local.ts",
    kind: "R3 local adapter delegation",
    detail: "checkout.exec and manifest read",
    task: "L3",
    count: 1,
  };
  const fallback = {
    file: app + "runners/local.ts",
    kind: "R3 local adapter delegation",
    detail: "checkout reads in process without a current child binding",
    task: "T18",
    count: 1,
  };
  assert.deepEqual(compareHistory([delegation], [delegation, fallback]), []);
  assert.equal(compareHistory([], [fallback]).length, 1);
  assert.equal(
    compareHistory([delegation], [delegation, { ...fallback, count: 2 }])
      .length,
    1
  );
  assert.deepEqual(
    scanSource(
      app + "runners/local.ts",
      'import { checkoutWorkload } from "../agents/checkout-worker.js";'
    ).map(({ kind, detail, task }) => [kind, detail, task]),
    [["R3 local adapter delegation", fallback.detail, "T18"]]
  );
});

test("T09's worker entry replaces main's checkout subcommand imports only as they go", () => {
  const entry = (module, count) => ({
    file: app + "main.ts",
    kind: "R2 host import",
    detail: app + "agents/" + module,
    task: "T04",
    count,
  });
  const before = [entry("checkout-inspection", 2), entry("checkout-watch", 1)];
  assert.deepEqual(compareHistory(before, [entry("checkout-worker", 2)]), []);
  assert.equal(compareHistory(before, [entry("checkout-worker", 3)]).length, 1);
  assert.equal(
    compareHistory(before, [
      entry("checkout-inspection", 2),
      entry("checkout-worker", 1),
    ]).length,
    1
  );
  assert.equal(compareHistory([], [entry("checkout-worker", 1)]).length, 1);
});

test("CI rejects an intermediate addition even when the final baseline shrinks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runner-boundary-history-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Runner Boundary Test");
    git("config", "user.email", "runner-boundary@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", "/dev/null");
    git("commit", "-qm", "Base", "--allow-empty");
    const base = git("rev-parse", "HEAD");
    mkdirSync(join(cwd, "scripts"));
    const commit = (entries) => {
      writeFileSync(
        join(cwd, "scripts/runner-boundary-baseline.json"),
        JSON.stringify(entries)
      );
      git("add", "scripts");
      git("commit", "-qm", "Change baseline");
    };
    const placement = countHits(
      scanSource(app + "example.ts", "remotePlacement(cwd)")
    );
    commit(placement);
    assert.deepEqual(historyErrors(cwd, base, "HEAD"), []);
    commit([
      ...placement,
      ...countHits(scanSource(app + "example.ts", 'import "node:fs";')),
    ]);
    commit([]);
    assert.match(
      historyErrors(cwd, base, "HEAD").join("\n"),
      /Baseline may only shrink.*fs/
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
