import { relative } from "node:path";
import {
  hostVocabularyCompatibility,
  isHostCompatibilityToken,
} from "./host-vocabulary-compatibility.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMON_ERRORS,
  ERROR_CODES,
  operations,
  surface,
  type OperationSpec,
} from "../src/contract/index.js";
import {
  usesContractVocabulary,
  usesDispatchVocabulary,
  vocabularyHits,
} from "./vocabulary.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const table = Object.entries(operations as Record<string, OperationSpec>);

describe("operation table (E4)", () => {
  it("has 71 operations including bounded origin reads", () => {
    expect(table).toHaveLength(71);
  });

  it.each(table)("%s is complete", (name, spec) => {
    expect(name).toMatch(/^[a-z]+(?:\.[a-zA-Z]+)+$/);
    for (const schema of [spec.request, spec.response]) {
      expect(typeof schema.check).toBe("function");
      expect(schema.shape).toBeDefined();
    }
    expect(["runner", "session"]).toContain(spec.scope);
    expect(["baseline", "selfUpdate"]).toContain(spec.capability);
    expect(["default", "long", "request"]).toContain(spec.timeout);
    expect(new Set(spec.errors).size).toBe(spec.errors.length);
    for (const code of spec.errors) {
      expect(ERROR_CODES).toContain(code);
      expect(COMMON_ERRORS).not.toContain(code);
    }
    // An open operation has a channel and a call has none.
    expect(spec.kind === "open").toBe(spec.channel !== undefined);
    // Keyed and state retries name fields the request has.
    const fields = Object.keys(
      (spec.request.shape as { object?: object }).object ?? {}
    );
    if (spec.retry.kind === "key")
      for (const field of spec.retry.key) expect(fields).toContain(field);
    if (spec.retry.kind === "state") expect(fields).toContain(spec.retry.field);
  });

  it("carries the engine's full effort description without truncation", () => {
    const catalog = {
      defaultModel: "model",
      models: [
        {
          id: "model",
          label: "Model",
          effort: [
            {
              value: "high",
              name: "High",
              description: "Engine detail. ".repeat(1000),
            },
          ],
        },
      ],
    };
    expect(operations["engine.models"].response.check(catalog)).toBe(true);
  });

  it("validators are structural, not stricter than the shape", () => {
    const launch = operations["session.launch"].request;
    const request = {
      session: "any handle, not agt_",
      launchId: "x".repeat(10_000),
      engine: "some-engine",
      model: null,
      effort: null,
      access: "full",
      resume: null,
      systemText: null,
      firstText: null,
      overflowNotice: null,
      env: { FOO: "bar", ID: { from: "session.id" } },
      mcp: [],
      owner: null,
      additive: "fields from newer peers are kept",
    };
    expect(launch.check(request)).toBe(true);
    expect(launch.check({ ...request, access: "other" })).toBe(false);
    expect(launch.check({ ...request, env: { FOO: 1 } })).toBe(false);
  });

  it("only selfUpdate is optional", () => {
    const optional = table.filter(([, spec]) => spec.capability !== "baseline");
    expect(optional.map(([name]) => name)).toEqual([
      "update.offer",
      "update.fence",
      "update.activate",
      "update.confirm",
      "update.cancel",
    ]);
  });
});

describe("surface snapshot (E8)", () => {
  it("surface.json is the committed surface; regenerate with `pnpm --filter @dispatch/runner-protocol surface`", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../surface.json", import.meta.url), "utf8")
    );
    expect(surface()).toEqual(committed);
  });

  it("the description has no field that identifies local or remote", () => {
    const fields = Object.keys(
      (surface().description as { object: object }).object
    );
    for (const banned of [
      "kind",
      "local",
      "remote",
      "os",
      "transport",
      "limits",
      "workspaces",
    ])
      expect(fields).not.toContain(banned);
  });
});

describe("vocabulary (E8)", () => {
  it("the contract and its snapshot use no Dispatch vocabulary", () => {
    expect(
      vocabularyHits(root, `${root}/src/contract`, usesContractVocabulary)
    ).toEqual([]);
    const strings: string[] = [];
    JSON.stringify(surface(), (key, value) => {
      strings.push(key);
      if (typeof value === "string") strings.push(value);
      return value;
    });
    expect(strings.filter(usesContractVocabulary)).toEqual([]);
  });

  it("the wire v1 modules hold only the known leaks (R5), and no new ones", () => {
    expect(vocabularyHits(root, `${root}/src`)).toEqual([
      "src/execution.ts: personaContext",
    ]);
  });

  it("the runner package and the client's launcher and socket use no Dispatch vocabulary", () => {
    for (const dir of [
      "../runner/src",
      "../runner-client/src/launcher",
      "../runner-client/src/transport",
    ])
      expect(
        vocabularyHits(
          root,
          `${root}/${dir}`,
          usesDispatchVocabulary,
          (file, token) =>
            isHostCompatibilityToken(
              relative(
                fileURLToPath(new URL("../../../", import.meta.url)),
                file
              ),
              token
            )
        )
      ).toEqual([]);
  });

  it("allows only exact compatibility bytes in their exact host files", () => {
    const entries = Object.values(hostVocabularyCompatibility).flat();
    expect(entries).toHaveLength(22);
    expect(
      isHostCompatibilityToken(
        "packages/runner/src/host/first-prompt.ts",
        "personaContext"
      )
    ).toBe(false);
    for (const entry of entries) {
      expect(entry.file.startsWith("packages/runner/src/host/")).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(usesDispatchVocabulary(entry.token)).toBe(true);
      expect(isHostCompatibilityToken(entry.file, entry.token)).toBe(true);
      expect(
        isHostCompatibilityToken("packages/runner/src/other.ts", entry.token)
      ).toBe(false);
      expect(
        isHostCompatibilityToken("packages/runner/src/host/new.ts", entry.token)
      ).toBe(false);
      expect(
        isHostCompatibilityToken(
          entry.file.replace("packages/runner/", "packages/runner-client/"),
          entry.token
        )
      ).toBe(false);
      expect(
        isHostCompatibilityToken(entry.file, "DISPATCH_NEW_HOST_FLAG")
      ).toBe(false);
    }
    expect(
      isHostCompatibilityToken(
        "packages/runner/src/host/host-env.ts",
        "preparePersonaContext"
      )
    ).toBe(false);
    expect(
      isHostCompatibilityToken(
        "packages/runner/src/host/engine-spec.ts",
        "personaDelivery"
      )
    ).toBe(false);
  });

  it("detects a planted term", () => {
    for (const planted of [
      "reviewBase",
      "personaContext",
      "task_id",
      "DISPATCH_FILES_DIR",
      ".dispatch/worktrees",
      "agt_123",
    ])
      expect(usesDispatchVocabulary(planted)).toBe(true);
    for (const planted of ["agentId", "PromptSource", "dispatchUrl"])
      expect(usesContractVocabulary(planted)).toBe(true);
    for (const neutral of ["checkout.preview", "previewUrl", "backgroundWork"])
      expect(usesDispatchVocabulary(neutral)).toBe(false);
  });
});
