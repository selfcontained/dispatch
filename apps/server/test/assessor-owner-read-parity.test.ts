import { execFileSync } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sessionFromWire, type Req } from "@dispatch/runner-protocol/contract";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { MergeRiskAssessor } from "../src/agents/merge-risk/assessor.js";
import {
  loadCodeownersFromFiles,
  parseCodeowners,
  type CodeownersConfig,
} from "../src/personas/codeowners.js";
import { OWNERS_PATH, LEGACY_OWNERS_PATH } from "../src/personas/paths.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { bindingFromRow } from "../src/runners/local-bindings.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import {
  ownedCheckoutFixture,
  ownerEvidence,
  ownerReply,
} from "./helpers/owned-checkout-fixture.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";
import path from "node:path";
let fixture: Awaited<ReturnType<typeof ownedCheckoutFixture>>;
let child: ReturnType<typeof startTestLocalRunner>;
beforeAll(async () => {
  fixture = await ownedCheckoutFixture(checkoutWorkload);
  const state = path.join(fixture.root, "assessor-local");
  const store = new BindingStore(state);
  for (const row of fixture.rows) {
    await store.import([bindingFromRow({ ...row, workspacePath: null })]);
    if (row.workspacePath) await store.select(row.id, row.workspacePath);
  }
  await fixture.finalizeGone();
  child = startTestLocalRunner(state);
  await child.ready();
  await child.session.call("runner.describe", {});
});
afterAll(async () => {
  await child?.stop();
  await fixture?.close();
});
const cases = [
  ["worktree", { "worktree-owner": 1 }],
  ["no-worktree", { "main-owner": 1 }],
  ["moved-repository", { "moved-owner": 1 }],
  ["moved-subfolder", { "moved-owner": 1 }],
  ["gone-worktree", {}],
  ["non-repository", { "folder-owner": 1 }],
] as const;
function assessor(
  owners: (
    id: string,
    runnerId: string | null
  ) => Promise<CodeownersConfig | null>
) {
  const options = { owners } as ConstructorParameters<
    typeof MergeRiskAssessor
  >[0];
  return new MergeRiskAssessor(options) as unknown as {
    owners(
      ids: string[],
      runnerId: string | null
    ): Promise<CodeownersConfig | null>;
  };
}
it.each(
  cases.flatMap(
    ([name, old]) =>
      [
        [name, old, "child"],
        [name, old, "no-child"],
        [name, old, "enrolled"],
      ] as const
  )
)(
  "pins main's owner-derived assessment (%s, %j, %s)",
  async (name, old, mode) => {
    const row = fixture.rows.find((row) => row.name === name)!;
    const placement =
      mode === "enrolled"
        ? placementForRunner("rnr_assessor")
        : controllerPlacement;
    const remote = {
      streamCheckoutRead(
        _placement: unknown,
        op: "checkout.access" | "checkout.read",
        input: Req<"checkout.access"> | Req<"checkout.read">
      ) {
        const { target, ...request } = input;
        if (!("session" in target)) throw new Error("Expected session");
        const selector =
          target.checkout === "owned" || target.checkout === "launch"
            ? "launch"
            : "current";
        return op === "checkout.access"
          ? fixture.access(
              row,
              selector,
              request as Omit<Req<"checkout.access">, "target">
            )
          : fixture.read(
              row,
              selector,
              request as Omit<Req<"checkout.read">, "target">
            );
      },
    } as unknown as RemoteRunnerService;
    const agent = {
      ...row,
      placement,
      cwd: mode === "enrolled" ? "runner://rnr_assessor/configured" : row.cwd,
    };
    const runner = runnerDirectory(
      mode === "enrolled"
        ? { remote }
        : mode === "child"
          ? { child: () => child.session }
          : {},
      agent
    ).for(placement);
    const target = {
      session: sessionFromWire(row.id),
      checkout: "owned" as const,
    };
    const grading = assessor(async () =>
      loadCodeownersFromFiles({
        access: (file) =>
          runner.call("checkout.access", { target, path: file }),
        read: async (file) =>
          (
            await runner.call("checkout.read", {
              target,
              path: file,
              mode: "native",
              encoding: "utf8",
              maxBytes: null,
            })
          )?.data ?? "",
      })
    );
    const config = await grading.owners(
      [row.id],
      mode === "enrolled" ? "rnr_assessor" : null
    );
    expect(JSON.stringify(ownerEvidence(config))).toBe(
      JSON.stringify(row.expected)
    );
    expect(await fixture.main(row)).toEqual(row.expected);
    if (mode === "enrolled")
      expect(
        ownerEvidence(
          await fixture
            .read(row, "current")
            .then(ownerReply)
            .catch(() => null)
        )
      ).toEqual(old);
  }
);
it("does not select legacy when the chosen primary disappears during its read", async () => {
  const calls: string[] = [];
  const grading = assessor(async () =>
    loadCodeownersFromFiles({
      access: async (file) => {
        calls.push("access:" + file);
        return true;
      },
      read: async (file) => {
        calls.push("read:" + file);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    })
  );
  expect(await grading.owners(["one"], null)).toBeNull();
  expect(calls).toEqual(["access:" + OWNERS_PATH, "read:" + OWNERS_PATH]);
});
it("preserves access-only primary/legacy selection and never reads an unselected file", async () => {
  const calls: string[] = [];
  const config = {
    version: 1,
    rules: [{ paths: ["src/**"], personas: ["legacy-owner"] }],
  };
  const grading = assessor(async () =>
    loadCodeownersFromFiles({
      access: async (file) => {
        calls.push("access:" + file);
        return file === LEGACY_OWNERS_PATH;
      },
      read: async (file) => {
        calls.push("read:" + file);
        return JSON.stringify(config);
      },
    })
  );
  expect(ownerEvidence(await grading.owners(["one"], null))).toEqual({
    "legacy-owner": 1,
  });
  expect(calls).toEqual([
    "access:" + OWNERS_PATH,
    "access:" + LEGACY_OWNERS_PATH,
    "read:" + LEGACY_OWNERS_PATH,
  ]);
});

it("keeps main's consuming FIFO map instead of the old enrolled empty assessment", async () => {
  const home = path.join(fixture.root, "fifo-grade");
  await mkdir(path.join(home, ".agents"), { recursive: true });
  const fifo = path.join(home, OWNERS_PATH);
  execFileSync("mkfifo", [fifo]);
  const old = assessor(async () => {
    const reply = await checkoutWorkload.run(
      "checkout.read",
      {
        directory: home,
        request: { path: OWNERS_PATH, encoding: "utf8", maxBytes: null },
      },
      {}
    );
    return reply ? parseCodeowners(reply.data) : null;
  });
  expect(ownerEvidence(await old.owners(["fifo"], "rnr_assessor"))).toEqual({});
  const runner = runnerDirectory(
    {},
    {
      id: "fifo",
      cwd: home,
      worktreePath: null,
      workspacePath: null,
      placement: controllerPlacement,
    }
  ).for(controllerPlacement);
  const target = {
    session: sessionFromWire("fifo"),
    checkout: "owned" as const,
  };
  const grading = assessor(async () =>
    loadCodeownersFromFiles({
      access: (file) => runner.call("checkout.access", { target, path: file }),
      read: async (file) =>
        (
          await runner.call("checkout.read", {
            target,
            path: file,
            mode: "native",
            encoding: "utf8",
            maxBytes: null,
          })
        )?.data ?? "",
    })
  );
  const pending = grading.owners(["fifo"], null);
  await writeFile(
    fifo,
    JSON.stringify({
      version: 1,
      rules: [{ paths: ["src/**"], personas: ["fifo-owner"] }],
    })
  );
  expect(ownerEvidence(await pending)).toEqual({ "fifo-owner": 1 });
});

it("pins old/new enrolled output for deletion between successful access and read", async () => {
  const home = path.join(fixture.root, "vanishing-grade");
  for (const file of [OWNERS_PATH, LEGACY_OWNERS_PATH])
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
  const config = (name: string) =>
    JSON.stringify({
      version: 1,
      rules: [{ paths: ["src/**"], personas: [name] }],
    });
  await writeFile(path.join(home, OWNERS_PATH), config("primary-owner"));
  await writeFile(path.join(home, LEGACY_OWNERS_PATH), config("legacy-owner"));
  const selected = assessor(async () =>
    loadCodeownersFromFiles({
      access: (file) =>
        checkoutWorkload.run(
          "checkout.access",
          { directory: home, request: { path: file } },
          {}
        ),
      read: async (file) => {
        await unlink(path.join(home, file));
        return (
          (
            await checkoutWorkload.run(
              "checkout.read",
              {
                directory: home,
                request: {
                  path: file,
                  mode: "native",
                  encoding: "utf8",
                  maxBytes: null,
                },
              },
              {}
            )
          )?.data ?? ""
        );
      },
    })
  );
  expect(
    ownerEvidence(await selected.owners(["vanishing"], "rnr_assessor"))
  ).toEqual({});
  const old = assessor(async () => {
    for (const file of [OWNERS_PATH, LEGACY_OWNERS_PATH]) {
      const reply = await checkoutWorkload.run(
        "checkout.read",
        {
          directory: home,
          request: { path: file, encoding: "utf8", maxBytes: null },
        },
        {}
      );
      if (reply) return parseCodeowners(reply.data, file);
    }
    return null;
  });
  expect(
    ownerEvidence(await old.owners(["vanishing"], "rnr_assessor"))
  ).toEqual({ "legacy-owner": 1 });
});
