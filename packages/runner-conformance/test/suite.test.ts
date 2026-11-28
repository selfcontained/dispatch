import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  RunnerCallError,
  operationNames,
  runnerIdFromWire,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { checked, ContractViolation } from "../src/checked.js";
import { compareBaseline, readBaseline, type Result } from "../src/run.js";
import {
  localScenarios,
  remoteScenarios,
  scenarios,
} from "../src/scenarios.js";

const baseline = readBaseline();

describe("coverage", () => {
  it("has a scenario for every operation", () => {
    const covered = new Set(scenarios.map((scenario) => scenario.op));
    expect(operationNames.filter((op) => !covered.has(op))).toEqual([]);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
  });

  it("names a task for every red entry and lists each once", () => {
    const ids = new Set(
      [...scenarios, ...localScenarios, ...remoteScenarios].map(
        (scenario) => scenario.id
      )
    );
    const seen = new Set<string>();
    for (const entry of baseline) {
      expect(["local", "remote", "adapter"]).toContain(entry.lane);
      expect(entry.task).toMatch(/^(T\d\db?|L\d)$/);
      expect(entry.reason).not.toBe("");
      expect(ids.has(entry.scenario), entry.scenario).toBe(true);
      const key = `${entry.lane} ${entry.scenario}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });
});

describe("local coverage", () => {
  it("shares every requested offline operation and keeps credentialed operations pending", () => {
    for (const op of [
      "workspace.prepare",
      "workspace.resume",
      "workspace.describe",
      "workspace.select",
      "workspace.observe",
      "workspace.release",
      "path.resolve",
      "path.complete",
      "checkout.write",
      "checkout.access",
      "git.context",
      "git.branches",
      "git.roots",
      "git.origin",
      "git.remoteHeads",
      "engine.list",
    ]) {
      const local = localScenarios.filter(
        (s) => s.op === op && !s.id.endsWith("/pending")
      );
      expect(local.length, op).toBeGreaterThan(0);
      for (const scenario of local)
        expect(remoteScenarios.includes(scenario), scenario.id).toBe(true);
    }
    for (const op of [
      "github.login.start",
      "engine.login.start",
      "engine.update",
      "port.connect",
      "update.offer",
    ])
      expect(
        localScenarios
          .filter((s) => s.op === op)
          .every((s) => s.id.endsWith("/pending")),
        op
      ).toBe(true);
  });

  it("runs every executable remote scenario locally and leaves only shared coverage gaps", () => {
    const ids = new Set(localScenarios.map(({ id }) => id));
    for (const scenario of remoteScenarios.filter(
      ({ id }) => !id.endsWith("/pending")
    ))
      expect(ids.has(scenario.id), scenario.id).toBe(true);
    for (const scenario of localScenarios.filter(({ id }) =>
      id.endsWith("/pending")
    )) {
      expect(
        remoteScenarios.some(
          ({ op, id }) => op === scenario.op && !id.endsWith("/pending")
        ),
        scenario.id
      ).toBe(false);
      expect(
        baseline.find(
          ({ lane, scenario: id }) => lane === "local" && id === scenario.id
        )?.reason
      ).toContain("No executable scenario exists on either lane");
    }
  });

  it("runs portable checkout, terminal and transfer scenarios rather than placeholders", () => {
    const ids = new Set(localScenarios.map(({ id }) => id));
    for (const id of [
      "checkout.read/large",
      "checkout.read/bytes",
      "checkout.list/entries",
      "terminal.open/interactive",
      "files.put/bytes",
      "git.defaultBranch/checkout-path",
      "git.base/fallback",
      "runner.health/success",
    ])
      expect(ids.has(id), id).toBe(true);
    expect(
      baseline.filter(
        ({ lane, reason }) =>
          lane === "local" && reason === "no local runner child yet"
      )
    ).toEqual([]);
  });
});

describe("compareBaseline", () => {
  const entry = {
    lane: "remote" as const,
    scenario: "a/x",
    task: "T14",
    reason: "r",
  };
  const result = (id: string, ok: boolean): Result => ({ id, ok, ms: 0 });

  it("accepts red failures and green passes", () => {
    expect(
      compareBaseline(
        "remote",
        [result("a/x", false), result("b/y", true)],
        [entry]
      )
    ).toEqual([]);
  });

  it("fails an unexpected pass, an unbaselined failure and an entry not run", () => {
    expect(compareBaseline("remote", [result("a/x", true)], [entry])).toEqual([
      "remote a/x passed unexpectedly; remove its baseline entry (T14).",
    ]);
    expect(
      compareBaseline("remote", [{ ...result("b/y", false), error: "e" }], [])
    ).toEqual(["remote b/y failed: e"]);
    expect(compareBaseline("remote", [], [entry])).toEqual([
      "remote a/x has a baseline entry but was not run.",
    ]);
  });
});

describe("checked", () => {
  const runner = (call: Runner["call"]): Runner => ({
    describe: () => ({
      runnerId: runnerIdFromWire("r"),
      displayName: "r",
      build: { version: "" },
      protocol: 1,
      engines: [],
      capabilities: {},
    }),
    connection: { state: "ready", epoch: 0, onChange: () => () => {} },
    call,
    open: async () => {
      throw new Error("no");
    },
  });

  it("rejects a response outside the schema", async () => {
    const bad = checked(runner(async () => ({ exitCode: "0" }) as never));
    await expect(bad.call("runner.health", {})).rejects.toBeInstanceOf(
      ContractViolation
    );
  });

  it("rejects a non-contract error and an undeclared code", async () => {
    const plain = checked(
      runner(async () => {
        throw new Error("boom");
      })
    );
    await expect(plain.call("runner.describe", {})).rejects.toBeInstanceOf(
      ContractViolation
    );
    const undeclared = checked(
      runner(async () => {
        throw new RunnerCallError({ code: "stale", message: "s" });
      })
    );
    await expect(undeclared.call("runner.describe", {})).rejects.toBeInstanceOf(
      ContractViolation
    );
  });

  it("passes a declared contract error through", async () => {
    const declared = checked(
      runner(async () => {
        throw new RunnerCallError({ code: "busy", message: "b" });
      })
    );
    await expect(
      declared.call("checkout.exec", {} as never)
    ).rejects.toMatchObject({ code: "busy" });
  });
});

describe("reference client", () => {
  /** Product names and the session id field the contract replaces. */
  const WORDS =
    /persona|review|task|board|brain|chat|\bjob|template|dispatch|agt_|agent_?id|promptsource/i;

  it("uses no product vocabulary outside its import specifiers", () => {
    const file = new URL("../src/reference-client.ts", import.meta.url);
    const source = ts.createSourceFile(
      "reference-client.ts",
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const hits: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) return;
      const text = ts.isIdentifier(node)
        ? node.text
        : ts.isStringLiteralLike(node)
          ? node.text
          : undefined;
      if (text !== undefined && WORDS.test(text)) hits.push(text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(hits).toEqual([]);
  });

  it("imports only the protocol, the client, Node and its own modules", () => {
    for (const name of ["reference-client.ts"]) {
      const text = readFileSync(
        new URL(`../src/${name}`, import.meta.url),
        "utf8"
      );
      const specifiers = [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      for (const specifier of specifiers)
        expect(specifier, `${name}: ${specifier}`).toMatch(
          /^(node:|\.\/|@dispatch\/runner-(protocol|client)(\/|$))/
        );
    }
  });
});
