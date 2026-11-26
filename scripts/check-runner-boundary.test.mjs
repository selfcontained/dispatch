import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import {
  compareHistory,
  compareMovePolicyHistory,
  movePolicyFixture,
  compareHits,
  countHits,
  historyErrors,
  ownMachineCapabilities,
  rekeyErrors,
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

// The same source must remain prohibited outside exact management paths.
test("R6 exempts only explicitly listed runner management screens", () => {
  const source =
    'import { remotePlacement } from "@dispatch/runner-protocol"; remotePlacement(agent.cwd)?.runner;';
  for (const screen of ["settings", "health", "update", "github-account"]) {
    assert.deepEqual(
      scanSource(`apps/web/src/components/app/runner-${screen}.tsx`, source),
      []
    );
  }
  for (const file of [
    web,
    "apps/web/src/components/app/chat/composer-meta.tsx",
    "apps/web/src/hooks/use-runner-engines.ts",
    "apps/web/src/components/app/runner-new-management-screen.tsx",
    "apps/web/src/components/app/new/runner-settings.tsx",
  ]) {
    const hits = scanSource(file, source);
    assert.equal(
      hits.filter((hit) => hit.kind.startsWith("R6 ")).length,
      3,
      file
    );
    assert.ok(compareHits(countHits(hits), []).length > 0, file);
  }
});

test("runner management exemption does not suppress other rules", () => {
  const hits = scanSource(
    "apps/web/src/components/app/runner-settings.tsx",
    'import "@dispatch/runner";'
  );
  assert.ok(hits.some((hit) => hit.kind === "R5 Dispatch to runner"));
});

test("host DTOs alone may reference ACP SDK types, never runtime values", () => {
  const host = "packages/runner-protocol/src/host.ts";
  const declared = new Set(["@agentclientprotocol/sdk"]);
  const sdk = 'import type { SessionUpdate } from "@agentclientprotocol/sdk";';
  assert.equal(scanSource(host, sdk, declared).length, 0);
  for (const [file, source] of [
    [host, 'import { SessionUpdate } from "@agentclientprotocol/sdk";'],
    [protocol, sdk],
    [host, 'import type { Row } from "pg";'],
  ]) {
    assert.ok(
      scanSource(file, source, declared).some(
        (hit) => hit.kind === "R5 package import"
      )
    );
  }
});

test("own-machine grants are exact paths and capabilities", () => {
  assert.deepEqual(
    scanSource(
      app + "agents/engine-update-operations.ts",
      "process.kill(process.pid, 0);"
    ),
    []
  );
  assert.ok(
    scanSource(
      app + "agents/engine-update-operations.ts",
      'import "node:child_process";'
    ).some((h) => h.kind === "R2 host access")
  );

  for (const file of [app + "db/migrate.ts", app + "local-tls.ts"]) {
    assert.deepEqual(scanSource(file, 'import "node:os";'), []);
    assert.ok(
      scanSource(file, 'import "node:worker_threads";').some(
        (h) => h.kind === "R2 host access"
      )
    );
  }
  for (const file of [
    app + "db/new-migration.ts",
    app + "new.ts",
    app + "new/local-tls.ts",
  ]) {
    assert.ok(
      scanSource(file, 'import "node:os"; import "node:fs";').length >= 2
    );
  }
  assert.deepEqual(
    scanSource(app + "diagnostics.ts", 'import "./shared/lib/run-command.js";'),
    []
  );
  assert.ok(
    scanSource(app + "diagnostics.ts", 'import "./shared/git/git-context.js";')
      .length
  );
  assert.ok(
    scanSource(app + "new.ts", 'import "./shared/lib/run-command.js";').length
  );
});

test("computed imports resolve only preceding literal const bindings in the same scope", () => {
  const file = "apps/web/src/lib/pwa-update.ts";
  assert.deepEqual(
    scanSource(
      file,
      'function init() { const pwaModule = "virtual:pwa-register"; void import(pwaModule); }'
    ),
    []
  );
  for (const source of [
    'let target = "virtual:pwa-register"; import(target);',
    'const target = prefix + "fs"; import(target);',
    'const target = "virtual:pwa-register"; target = other; import(target);',
    'const target = "virtual:pwa-register"; function f(target) { import(target); }',
    'import(target); const target = "virtual:pwa-register";',
    'const target = "virtual:pwa-register"; const f = (target) => import(target);',
  ])
    assert.ok(
      scanSource(file, source).some((h) => h.kind === "R2 computed import"),
      source
    );
  for (const source of [
    'const target = "node:fs"; import(target);',
    'const target = "./shared/git/git-context.js"; import(target);',
  ])
    assert.ok(
      scanSource(app + "new.ts", source).some((h) => h.kind.startsWith("R2 ")),
      source
    );
});

test("controller logs, attachments and metrics grants apply only at their owners", () => {
  for (const [owner, capability] of [
    ["jobs/setup-log.ts", "fs/promises"],
    ["observability/service-resources.ts", "os"],
    ["server/mcp-file-storage.ts", "fs/promises"],
    ["tasks/attachment-storage.ts", "fs/promises"],
  ]) {
    const source = `import "node:${capability}";`;
    assert.deepEqual(scanSource(app + owner, source), []);
    assert.ok(scanSource(app + owner.replace(".ts", "-other.ts"), source).some(hit => hit.kind === "R2 host access" && hit.detail === capability));
    assert.ok(scanSource(app + owner, 'import "node:fs";').some(hit => hit.kind === "R2 host access" && hit.detail === "fs"));
  }
});

test("every exact own-machine grant accepts only its named capability", () => {
  const sources = {
    fs: 'import "node:fs";',
    "fs/promises": 'import "node:fs/promises";',
    os: 'import "node:os";',
    process: 'import "node:child_process";',
    openssl: 'Bun.spawn(["openssl", "version"]);',
    du: 'Bun.spawn(["du", "-sk", path]);',
    child_process: 'import "node:child_process";',
    "process.kill": "process.kill(process.pid, 0);",
    "loopback fetch": 'fetch("http://127.0.0.1:9123/health");',
  };
  for (const [file, capabilities] of ownMachineCapabilities) {
    for (const [capability, reason] of capabilities) {
      assert.ok(reason.length > 0);
      let source = sources[capability];
      if (capability.startsWith("import:")) {
        const target = capability.slice("import:".length);
        source = `import "${posix.relative(posix.dirname(file), target).replace(/^(?!\.)/, "./")}.js";`;
      }
      assert.ok(source, capability);
      assert.deepEqual(scanSource(file, source), [], `${file}: ${capability}`);
    }
    assert.ok(
      scanSource(file, 'process.getBuiltinModule("fs");').some(
        (h) => h.kind === "R2 host access"
      ),
      file
    );
  }
});

function moveFixture() {
  const old = {
    file: app + "agents/acp/runtime.ts",
    kind: "R2 host import",
    detail: app + "agents/acp/host-client",
    task: "T04",
    count: 1,
  };
  const entry = {
    file: old.file,
    kind: "R5 Dispatch to client transport",
    detail: "@dispatch/runner-client/host-client",
    task: "T40",
    count: 1,
    class: "route-through-runner",
  };
  const keyOf = ({ file, kind, detail }) => ({ file, kind, detail });
  const record = {
    type: "package-import",
    key: keyOf(entry),
    target: "packages/runner-client/src/host-client.ts",
    task: "T40",
    class: entry.class,
    reason: "Host client moved.",
    supersedes: [keyOf(old)],
  };
  const policy = { budget: 1, importers: [entry.file], records: [record] };
  const files = new Map([
    [
      "packages/runner-client/package.json",
      JSON.stringify({ exports: { "./host-client": "./src/host-client.ts" } }),
    ],
    [record.target, "export {};"],
    ["packages/runner/src/host/main.ts", "export {};"],
    [app + "agents/engine-availability.ts", "export {};"],
  ]);
  const read = (file) => files.get(file);
  const context = { previousPolicy: { ...policy, records: [] }, read };
  return { old, entry, record, policy, context, read, keyOf, files };
}

test("exact package moves remain counted, may expose debt, and cannot admit unrelated hits", () => {
  const { old, entry, record, policy, context, read, keyOf, files } =
    moveFixture();
  assert.deepEqual(compareHistory([old], [entry], policy, context), []);
  assert.deepEqual(
    compareHistory([old], [{ ...entry, count: 3 }], policy, context),
    []
  );
  assert.ok(
    compareHistory([old], [entry], { ...policy, records: [] }, context).some(
      (e) => e.startsWith("Baseline may only shrink")
    )
  );
  assert.ok(compareHistory([old], [old, entry], policy, context).length);
  assert.ok(
    compareHistory([entry], [{ ...entry, count: 2 }], policy, context).length
  );
  assert.ok(
    rekeyErrors(policy, [], read).some((e) => e.startsWith("Stale move re-key"))
  );
  assert.ok(rekeyErrors({ ...policy, budget: 0 }, [entry], read).length);
  assert.ok(rekeyErrors({ ...policy, importers: [] }, [entry], read).length);
  assert.ok(
    rekeyErrors(
      {
        ...policy,
        records: [{ ...record, target: "apps/server/src/host.ts" }],
      },
      [entry],
      read
    ).length
  );
  files.delete(record.target);
  assert.ok(rekeyErrors(policy, [entry], read).length);
  files.set(record.target, "export {};");
  files.set(
    "packages/runner-client/package.json",
    JSON.stringify({
      exports: { "./host-client": "../../apps/server/src/main.ts" },
    })
  );
  assert.ok(rekeyErrors(policy, [entry], read).length);
  for (const rule of ["R1", "R2", "R3", "R6", "R7"]) {
    const forbidden = { ...entry, kind: rule + " addition" };
    assert.ok(
      compareHistory(
        [old],
        [forbidden],
        { ...policy, records: [{ ...record, key: keyOf(forbidden) }] },
        context
      ).some((e) => e.startsWith("Baseline may only shrink"))
    );
  }
  assert.ok(
    rekeyErrors({ ...policy, importers: ["apps/**"] }, [entry], read).length
  );
});

test("input seams are only main's app providers for consumers that exist in packages", () => {
  const { read, keyOf } = moveFixture();
  const entry = {
    file: app + "main.ts",
    kind: "R2 host import",
    detail: app + "agents/engine-availability",
    task: "T40",
    count: 1,
    class: "moves-with-workload",
  };
  const record = {
    type: "input-seam",
    key: keyOf(entry),
    class: entry.class,
    task: "T40",
    reason: "Supply the existing provider to the moved host.",
    provider: app + "agents/engine-availability.ts",
    consumers: ["packages/runner/src/host/main.ts"],
    movedDependency: app + "agents/acp/host/main.ts",
  };
  const policy = { budget: 1, importers: [], records: [record] };
  const context = { previousPolicy: { ...policy, records: [] }, read };
  assert.deepEqual(compareHistory([], [entry], policy, context), []);
  const other = { ...entry, file: app + "other.ts" };
  assert.ok(
    rekeyErrors(
      {
        ...policy,
        importers: [other.file],
        records: [{ ...record, key: keyOf(other) }],
      },
      [other],
      read
    ).length
  );
  assert.ok(
    rekeyErrors(
      { ...policy, records: [{ ...record, consumers: [app + "main.ts"] }] },
      [entry],
      read
    ).length
  );
  assert.ok(
    rekeyErrors(
      {
        ...policy,
        records: [{ ...record, consumers: ["packages/runner/src/missing.ts"] }],
      },
      [entry],
      read
    ).length
  );
  const moved = {
    ...entry,
    detail: "@dispatch/runner/host/engine-availability",
  };
  assert.ok(
    rekeyErrors(
      {
        ...policy,
        records: [
          {
            ...record,
            key: keyOf(moved),
            provider: "packages/runner/src/host/engine-availability.ts",
          },
        ],
      },
      [moved],
      read
    ).length
  );
  assert.ok(
    rekeyErrors(policy, [entry], (file) =>
      file === record.provider ? undefined : read(file)
    ).some((e) => e.startsWith("Stale or invalid"))
  );
});

test("budget/importer growth requires the reviewed fixture naming commit 81662d1b", () => {
  // Future increases must name their reviewed base commit here and in the fixture.
  assert.equal(
    movePolicyFixture.initialAdoption.commit.slice(0, 8),
    "81662d1b"
  );
  assert.deepEqual(movePolicyFixture.reviewedIncreases, []);
  assert.equal(movePolicyFixture.initialAdoption.budget, 21);
  const { policy } = moveFixture();
  assert.ok(compareMovePolicyHistory(policy, { ...policy, budget: 2 }).length);
  assert.ok(
    compareMovePolicyHistory(policy, {
      ...policy,
      importers: [...policy.importers, app + "new.ts"],
    }).length
  );
  assert.deepEqual(
    compareMovePolicyHistory(policy, { budget: 0, importers: [], records: [] }),
    []
  );
  assert.ok(compareMovePolicyHistory(policy, []).length);
  assert.ok(
    compareMovePolicyHistory({ ...policy, budget: 0, records: [] }, policy, {
      inheritedPolicies: [policy],
    }).length
  );
  assert.ok(
    compareMovePolicyHistory({ ...policy, importers: [] }, policy, {
      inheritedPolicies: [policy],
    }).length
  );

  const initial = {
    budget: 21,
    importers: movePolicyFixture.initialAdoption.importers,
    records: [],
  };
  assert.deepEqual(
    compareMovePolicyHistory([], initial, {
      baseRevision: movePolicyFixture.initialAdoption.commit,
    }),
    []
  );
  assert.ok(
    compareMovePolicyHistory(
      [],
      { ...initial, budget: 22 },
      { baseRevision: movePolicyFixture.initialAdoption.commit }
    ).length
  );
  assert.ok(
    compareMovePolicyHistory([], initial, { baseRevision: "unreviewed" }).length
  );
  assert.deepEqual(
    compareMovePolicyHistory([], initial, { inheritedPolicies: [initial] }),
    []
  );
  assert.ok(
    compareMovePolicyHistory(
      [],
      { ...initial, importers: [...initial.importers, app + "new.ts"] },
      { inheritedPolicies: [initial] }
    ).length
  );
  assert.deepEqual(
    movePolicyFixture.frozenLegacyPolicies.map((item) =>
      item.commit.slice(0, 8)
    ),
    ["fb86dd1d", "81662d1b"]
  );
  for (const snapshot of movePolicyFixture.frozenLegacyPolicies) {
    const policy = JSON.parse(
      execFileSync(
        "git",
        ["show", snapshot.commit + ":scripts/runner-boundary-rekeys.json"],
        { encoding: "utf8" }
      )
    );
    assert.equal(
      createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
      snapshot.sha256
    );
  }
  assert.ok(rekeyErrors([{ key: {} }], []).length);
});

// A renumbered migration is the same debt under a new file name.
test("history keeps an entry across a byte-identical file rename only", () => {
  const old = {
    file: app + "db/migrations/0054_runner_registrations.sql",
    kind: "R1 locator",
    detail: "runner:// in SQL",
    task: "T07",
    count: 1,
  };
  const moved = {
    ...old,
    file: app + "db/migrations/0055_runner_registrations.sql",
  };
  const renames = new Map([[moved.file, old.file]]);
  assert.deepEqual(compareHistory([old], [moved], [], { renames }), []);
  // Not a recorded rename: still new debt.
  assert.equal(compareHistory([old], [moved], [], {}).length, 1);
  assert.equal(
    compareHistory([old], [moved], [], { renames: new Map() }).length,
    1
  );
  // The old key must be gone, the count must not grow, the fields must match.
  assert.ok(compareHistory([old], [old, moved], [], { renames }).length);
  assert.ok(
    compareHistory([old], [{ ...moved, count: 2 }], [], { renames }).length
  );
  assert.ok(
    compareHistory([old], [{ ...moved, detail: "another hit" }], [], {
      renames,
    }).length
  );
  assert.ok(
    compareHistory([old], [{ ...moved, task: "T40" }], [], { renames }).length
  );
});
