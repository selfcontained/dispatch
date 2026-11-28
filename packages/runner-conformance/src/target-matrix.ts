import {
  displayPath,
  RunnerCallError,
  pathFromWire,
  sessionFromWire,
  type Runner,
  type Target,
  type OpName,
} from "@dispatch/runner-protocol/contract";
import type { Scenario, LaneFixture } from "./scenarios.js";

export const MATRIX_TEXT = "target-kind sentinel ✓\n";
export const MATRIX_PATH = "target-matrix/read.txt";
export const MATRIX_IMAGE = "target-matrix/image.png";
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
type Case = { op: OpName; read(runner: Runner, target: Target): Promise<void> };
const cases: Case[] = [
  {
    op: "checkout.access",
    async read(r, target) {
      assert(
        await r.call("checkout.access", { target, path: MATRIX_PATH }),
        "Sentinel is inaccessible"
      );
    },
  },
  {
    op: "checkout.read",
    async read(r, target) {
      assert(
        (
          await r.call("checkout.read", {
            target,
            path: MATRIX_PATH,
            encoding: "utf8",
            maxBytes: null,
          })
        )?.data === MATRIX_TEXT,
        "Wrong sentinel bytes"
      );
    },
  },
  {
    op: "checkout.list",
    async read(r, target) {
      assert(
        (
          await r.call("checkout.list", { target, path: "target-matrix" })
        ).entries.some((e) => e.path === MATRIX_PATH && e.kind === "file"),
        "Sentinel is missing from listing"
      );
    },
  },
  {
    op: "checkout.preview",
    async read(r, target) {
      const v = await r.call("checkout.preview", { target, path: MATRIX_PATH });
      assert(v.kind === "text" && v.text === MATRIX_TEXT, "Wrong preview");
    },
  },
  {
    op: "checkout.index",
    async read(r, target) {
      assert(
        (
          await r.call("checkout.index", {
            target,
            generation: "target-matrix",
          })
        ).paths.includes(MATRIX_PATH),
        "Sentinel is missing from index"
      );
    },
  },
  {
    op: "checkout.stats",
    async read(r, target) {
      const v = await r.call("checkout.stats", {
        target,
        base: "main",
        uncommitted: true,
        exclude: [],
      });
      assert(
        v !== null && v.files === 0,
        "Clean checkout has changed-file stats"
      );
    },
  },
  {
    op: "checkout.diff",
    async read(r, target) {
      const v = await r.call("checkout.diff", {
        target,
        base: "main",
        uncommitted: true,
        exclude: [],
        whitespace: "show",
      });
      assert(
        v === null || ("files" in v && v.files.length === 0),
        "Clean checkout has a diff"
      );
    },
  },
  {
    op: "checkout.changes",
    async read(r, target) {
      assert(
        (await r.call("checkout.changes", { target, base: "main" })).files
          .length === 0,
        "Clean checkout has changes"
      );
    },
  },
  {
    op: "checkout.image",
    async read(r, target) {
      const v = await r.call("checkout.image", {
        target,
        base: "main",
        uncommitted: true,
        path: MATRIX_IMAGE,
        side: "new",
      });
      assert(
        Buffer.from(v.bytes, "base64").toString() === MATRIX_TEXT,
        "Wrong image bytes"
      );
    },
  },
  {
    op: "checkout.defaultFiles",
    async read(r, target) {
      const v = await r.call("checkout.defaultFiles", {
        target,
        dirs: [".agents/personas"],
        wait: true,
      });
      assert(
        v.hasOrigin && v.files.some((f) => f.path.endsWith("target-matrix.md")),
        "Missing default-branch definition"
      );
    },
  },
  {
    op: "checkout.watch",
    async read(r, target) {
      const { channel } = await r.open("checkout.watch", { target });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("No initial checkout pulse")),
            2_000
          );
          channel.onData(() => {
            clearTimeout(timer);
            resolve();
          });
          channel.onClose(() => {
            clearTimeout(timer);
            reject(new Error("Watch closed before pulse"));
          });
        });
      } finally {
        channel.close();
      }
    },
  },
  {
    op: "git.roots",
    async read(r, target) {
      const v = await r.call("git.roots", { target });
      assert(v.repositoryRoot && v.checkoutRoot, "Missing Git roots");
    },
  },
  {
    op: "git.context",
    async read(r, target) {
      const v = await r.call("git.context", { target });
      assert(
        v?.branch === ("repository" in target ? "main" : "target-matrix"),
        "Wrong Git context branch"
      );
    },
  },
  {
    op: "git.defaultBranch",
    async read(r, target) {
      assert(
        (await r.call("git.defaultBranch", { target })).branch === "main",
        "Wrong default branch"
      );
    },
  },
  {
    op: "git.branches",
    async read(r, target) {
      assert(
        (await r.call("git.branches", { target })).branches.includes("main"),
        "Origin branch list omitted main"
      );
    },
  },
  {
    op: "git.base",
    async read(r, target) {
      assert(
        (
          await r.call("git.base", {
            target,
            requested: "target-matrix-missing",
            fallback: ["origin/main"],
          })
        ).base === "origin/main",
        "Wrong Git base"
      );
    },
  },
];
export const TARGET_MATRIX_OPERATIONS = cases.map(({ op }) => op);
async function binding(fixture: LaneFixture) {
  if (!fixture.workspace) throw new Error("Missing offline repository fixture");
  const session = sessionFromWire("conformance-target-matrix");
  const runner = fixture.workspace.runner;
  const prepared = await runner.call("workspace.prepare", {
    session,
    source: {
      repository: fixture.workspace.repository,
      checkout: { kind: "new", branch: "target-matrix" },
    },
    copyIgnored: [],
    installDependencies: false,
  });
  return {
    runner,
    session,
    path: displayPath(prepared.path),
    repository: fixture.workspace.repository,
  };
}
// These are explicit rejections in the enrolled handlers, not missing Local
// implementations: read streams require sessions (except defaultFiles), and
// watches/context/base reject repository targets. Keep the same assertions on
// both lanes rather than treating their shared refusal as a parked Local gap.
const rejectedRepositoryTargets = new Set<OpName>([
  "checkout.access",
  "checkout.read",
  "checkout.list",
  "checkout.preview",
  "checkout.index",
  "checkout.stats",
  "checkout.diff",
  "checkout.changes",
  "checkout.image",
  "checkout.watch",
  "git.context",
  "git.base",
]);
/** One definition per operation/kind, used without adaptation on both lanes. */
export const targetMatrix: readonly Scenario[] = cases.flatMap((test) =>
  (["session", "path", "repository"] as const).map((kind) => ({
    op: test.op,
    id: `${test.op}/target-${kind}`,
    async run(fixture: LaneFixture) {
      const f = await binding(fixture);
      const target =
        kind === "session"
          ? { session: f.session }
          : kind === "path"
            ? { path: pathFromWire(f.path) }
            : { repository: f.repository };
      if (
        (kind === "repository" && rejectedRepositoryTargets.has(test.op)) ||
        (kind === "path" && test.op === "checkout.watch")
      ) {
        try {
          await test.read(f.runner, target);
        } catch (error) {
          if (error instanceof RunnerCallError && error.code === "invalid")
            return;
          throw error;
        }
        throw new Error(`${test.op} accepted an invalid ${kind} target`);
      }
      await test.read(f.runner, target);
    },
  }))
);
