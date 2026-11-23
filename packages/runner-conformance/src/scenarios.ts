import { createHash } from "node:crypto";
/*
 * One scenario set for every implementation of the contract. A scenario talks
 * to a `Runner` only; the lane supplies the runner and a session whose
 * checkout it can seed. Every operation has at least one scenario. An
 * operation whose scenarios have not been written yet has a `pending`
 * scenario that fails, so it is a named red baseline entry, never a skip.
 */
import {
  RunnerCallError,
  displayPath,
  operationNames,
  pathFromWire,
  sessionFromWire,
  type ErrorCode,
  type OpName,
  type Req,
  type Runner,
  type SessionHandle,
} from "@dispatch/runner-protocol/contract";
import { launchRequest, promptSession, replay, turnText } from "./session.js";
import { OPERATION_TASK, SCENARIO_TASK } from "./tasks.js";

export type LaneFixture = {
  /** Already wrapped with `checked`. */
  runner: Runner;
  /** A session whose current checkout `seed` writes into. */
  session: SessionHandle;
  /** Writes a file at a relative path in the session's checkout. */
  seed(path: string, content: string): Promise<void>;
  /** Older wire command guards also bind the digest to the resolved root. */
  readGuard?(session: SessionHandle, path: string): Promise<string>;
  workspace?: {
    runner: Runner;
    repository: string;
    interrupt(session: SessionHandle): Promise<void>;
    proveIsolation(session: SessionHandle, path: string): Promise<void>;
    proveRelease(
      external: Runner,
      externalSession: SessionHandle
    ): Promise<void>;
  };
};

export type Scenario = {
  /** `<operation>/<case>` */
  id: string;
  op: OpName;
  run(fixture: LaneFixture): Promise<void>;
};

export class ScenarioFailure extends Error {
  override name = "ScenarioFailure";
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioFailure(message);
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: ErrorCode
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RunnerCallError) {
      expect(
        error.code === code,
        `Expected ${code}, got ${error.code}: ${error.message}`
      );
      return;
    }
    throw error;
  }
  throw new ScenarioFailure(`Expected ${code}, but the call succeeded.`);
}

const GUARD = "conformance/guard.txt";
const UNKNOWN_SESSION = sessionFromWire("unknown-session");

/** Seeds the guard file and reads it back for the digest a guarded command needs. */
async function guarded(
  fixture: LaneFixture,
  argv: string[],
  content = "guard\n"
): Promise<Req<"checkout.exec">> {
  await fixture.seed(GUARD, content);
  const target = { session: fixture.session, checkout: "current" } as const;
  const file = await fixture.runner.call("checkout.read", {
    target,
    path: GUARD,
    encoding: "utf8",
    maxBytes: null,
  });
  expect(file?.data === content, "checkout.read returned other content.");
  expect(file.digest, "checkout.read returned no digest to guard with.");
  return {
    target,
    guard: {
      path: GUARD,
      digest:
        (await fixture.readGuard?.(fixture.session, GUARD)) ?? file.digest,
    },
    argv,
    env: {},
    timeoutMs: null,
    maxOutput: null,
    shell: "direct",
  };
}

const written: Scenario[] = [
  {
    id: "files.get/bytes",
    op: "files.get",
    async run({ runner, session, seed }) {
      const path = "conformance/attachment.txt";
      const contents = "file contents ✓\n";
      await seed(path, contents);
      const file = await runner.call("files.get", { session, path });
      expect(file.name === "attachment.txt", "Wrong file name.");
      expect(file.size === Buffer.byteLength(contents), "Wrong file size.");
      expect(
        file.digest === createHash("sha256").update(contents).digest("hex"),
        "Wrong digest."
      );
      expect(
        file.blob === Buffer.from(contents).toString("base64"),
        "Wrong file bytes."
      );
    },
  },
  {
    id: "runner.describe/success",
    op: "runner.describe",
    async run({ runner }) {
      const described = await runner.call("runner.describe", {});
      const offline = runner.describe();
      expect(
        JSON.stringify(described.runnerId) === JSON.stringify(offline.runnerId),
        "runner.describe and describe() name different runners."
      );
    },
  },
  {
    id: "checkout.exec/success",
    op: "checkout.exec",
    async run(fixture) {
      const req = await guarded(fixture, [
        "sh",
        "-c",
        "printf out; printf err >&2; exit 3",
      ]);
      const result = await fixture.runner.call("checkout.exec", req);
      expect(result.exitCode === 3, `exitCode ${result.exitCode}, want 3`);
      expect(
        result.stdout === "out",
        `stdout ${JSON.stringify(result.stdout)}`
      );
      expect(
        result.stderr === "err",
        `stderr ${JSON.stringify(result.stderr)}`
      );
    },
  },
  {
    id: "checkout.exec/stale",
    op: "checkout.exec",
    async run(fixture) {
      const req = await guarded(fixture, ["true"]);
      await fixture.seed(GUARD, "changed\n");
      await rejectsWith(fixture.runner.call("checkout.exec", req), "stale");
    },
  },
  {
    id: "checkout.exec/cancelled",
    op: "checkout.exec",
    async run(fixture) {
      const req = await guarded(fixture, ["sh", "-c", "sleep 10"]);
      const controller = new AbortController();
      const call = fixture.runner.call("checkout.exec", req, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 300);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hung = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new ScenarioFailure("Not cancelled within 2 s of abort.")),
          2_300
        );
      });
      // A runner that ignores the signal must not hold the suite for the command's length.
      call.catch(() => {});
      await rejectsWith(Promise.race([call, hung]), "cancelled").finally(() =>
        clearTimeout(timer)
      );
    },
  },
  {
    id: "session.launch/retry",
    op: "session.launch",
    async run({ runner }) {
      const session = sessionFromWire("launch-retry");
      const request = launchRequest(session);
      await runner.call("session.launch", request);
      try {
        await runner.call("session.launch", request);
        expect(
          (await runner.call("session.alive", { session })).state === "live",
          "The retried launch did not leave a live session."
        );
      } finally {
        await runner.call("session.stop", { session, force: false });
        await runner.call("session.discard", { session });
      }
    },
  },
  {
    id: "session.launch/conflict",
    op: "session.launch",
    async run({ runner, session }) {
      await rejectsWith(
        runner.call("session.launch", launchRequest(session)),
        "conflict"
      );
    },
  },
  {
    id: "session.launch/environment",
    op: "session.launch",
    async run({ runner }) {
      const session = sessionFromWire("launch-environment");
      const key = "CONFORMANCE_SAMPLE";
      const value = "sample";
      await runner.call(
        "session.launch",
        launchRequest(session, { env: { [key]: value } })
      );
      try {
        const { events } = await promptSession(
          runner,
          session,
          `proof-conformance-env:${key}`
        );
        const observed = JSON.parse(turnText(events));
        expect(
          observed.env === value,
          "The fixture engine did not receive the launch environment."
        );
      } finally {
        await runner.call("session.stop", { session, force: false });
        await runner.call("session.discard", { session });
      }
    },
  },
  {
    id: "session.attach/prompt-and-replay",
    op: "session.attach",
    async run({ runner, session }) {
      const { events, journalId, fromSeq } = await promptSession(
        runner,
        session,
        "Say hello."
      );
      expect(
        turnText(events).length > 0,
        "The engine did not emit a text update."
      );
      const [first, ...unseen] = events;
      expect(first && unseen.length, "The turn did not have a replay suffix.");
      const { channel } = await runner.open("session.attach", { session });
      try {
        const resumed = await replay(channel, first.seq, journalId);
        expect(
          first.seq === fromSeq + 1,
          "The original turn had a journal gap."
        );
        expect(
          JSON.stringify(resumed.events) === JSON.stringify(unseen),
          "Replay did not match the unseen live events."
        );
      } finally {
        channel.close();
      }
    },
  },
  {
    id: "session.attach/unknown",
    op: "session.attach",
    async run({ runner }) {
      await rejectsWith(
        runner
          .open("session.attach", { session: UNKNOWN_SESSION })
          .then(({ channel }) => {
            channel.close();
          }),
        "host_gone"
      );
    },
  },
  {
    id: "session.alive/live",
    op: "session.alive",
    async run({ runner, session }) {
      expect(
        (await runner.call("session.alive", { session })).state === "live",
        "Expected a live session."
      );
    },
  },
  {
    id: "session.logs/success",
    op: "session.logs",
    async run({ runner, session }) {
      const { text } = await runner.call("session.logs", {
        session,
        lines: 20,
      });
      expect(text.trim().split("\n").length > 1, "Expected host log entries.");
    },
  },
  {
    id: "session.logs/line-limit",
    op: "session.logs",
    async run({ runner, session }) {
      const { text } = await runner.call("session.logs", { session, lines: 1 });
      expect(
        text.trimEnd().split("\n").length === 1,
        "Expected a one-line session log."
      );
    },
  },
  {
    id: "session.logs/unknown",
    op: "session.logs",
    async run({ runner }) {
      await rejectsWith(
        runner.call("session.logs", { session: UNKNOWN_SESSION, lines: 20 }),
        "not_found"
      );
    },
  },
  {
    id: "session.list/live",
    op: "session.list",
    async run({ runner, session }) {
      const { sessions } = await runner.call("session.list", { owner: null });
      expect(
        sessions.some(
          (entry) => entry.session === session && entry.state === "live"
        ),
        "The list omitted the live session."
      );
    },
  },
  {
    id: "session.discard/busy",
    op: "session.discard",
    async run({ runner, session }) {
      await rejectsWith(runner.call("session.discard", { session }), "busy");
    },
  },
  // Finish the fixture's lifecycle after the scenarios that need it live.
  {
    id: "session.stop/repeat",
    op: "session.stop",
    async run({ runner, session }) {
      const request = { session, force: false };
      await runner.call("session.stop", request);
      expect(
        (await runner.call("session.alive", { session })).state === "gone",
        "The session survived stop."
      );
      await runner.call("session.stop", request);
    },
  },
  {
    id: "session.attach/stopped",
    op: "session.attach",
    async run({ runner, session }) {
      await rejectsWith(
        runner.open("session.attach", { session }).then(({ channel }) => {
          channel.close();
        }),
        "host_gone"
      );
    },
  },
  {
    id: "session.discard/success",
    op: "session.discard",
    async run({ runner, session }) {
      await runner.call("session.discard", { session });
    },
  },
  {
    id: "session.alive/discarded",
    op: "session.alive",
    async run({ runner, session }) {
      expect(
        (await runner.call("session.alive", { session })).state === "gone",
        "Expected a discarded session to be gone."
      );
    },
  },
];

function pending(op: OpName): Scenario {
  const task = SCENARIO_TASK[op] ?? OPERATION_TASK[op];
  return {
    id: `${op}/pending`,
    op,
    async run() {
      throw new ScenarioFailure(`No scenario yet; ${task} writes it.`);
    },
  };
}

/** Written scenarios, then one pending scenario for each operation without any. */
export const scenarios: readonly Scenario[] = [
  ...written,
  ...operationNames
    .filter((op) => !written.some((scenario) => scenario.op === op))
    .map(pending),
];

// These replace the T09 pending cases on the Linux lane. The local lane
// retains its existing baseline until it has its own fixture.
const readPath = "checkout-reads/content.txt";
const readText = "workload café\n".repeat(24_000);
const checkoutReads: Scenario[] = [
  {
    op: "checkout.read",
    id: "checkout.read/large",
    async run({ runner, session, seed }) {
      await seed(readPath, readText);
      const input = {
        target: { session },
        path: readPath,
        encoding: "utf8",
        maxBytes: null,
      } as const;
      const result = await runner.call("checkout.read", input);
      expect(result?.data === readText, "The file was cut short or changed.");
      expect(
        result.digest === createHash("sha256").update(readText).digest("hex"),
        "Wrong file digest."
      );
      await rejectsWith(
        runner.call("checkout.read", { ...input, maxBytes: 25 }),
        "too_large"
      );
      const privateFile = await runner
        .call("checkout.read", { ...input, path: ".root-only" })
        .catch(() => null);
      expect(
        privateFile === null,
        "A checkout read ran with access to a root-only file."
      );
    },
  },
  {
    op: "checkout.read",
    id: "checkout.read/bytes",
    async run({ runner, session }) {
      const input = {
        target: { session },
        path: readPath,
        encoding: "base64",
        maxBytes: null,
      } as const;
      const bytes = Buffer.from(readText);
      const result = await runner.call("checkout.read", input);
      expect(
        result?.data === bytes.toString("base64"),
        "The raw bytes were cut short or changed."
      );
      expect(
        result.digest === createHash("sha256").update(bytes).digest("hex"),
        "Wrong file digest."
      );
      await rejectsWith(
        runner.call("checkout.read", { ...input, maxBytes: 0 }),
        "too_large"
      );
      expect(
        (await runner.call("checkout.read", {
          ...input,
          path: "checkout-reads/missing.bin",
        })) === null,
        "A missing file read as present."
      );
    },
  },
  {
    op: "checkout.list",
    id: "checkout.list/entries",
    async run({ runner, session }) {
      const result = await runner.call("checkout.list", {
        target: { session },
        path: "checkout-reads",
      });
      expect(
        result.entries.some(
          (entry) => entry.path === readPath && entry.kind === "file"
        ),
        "The checkout entry was missing."
      );
      const files = await runner.call("checkout.list", {
        target: { session },
        path: "file-list",
        filesOnly: true,
      });
      expect(
        !files.truncated && files.entries.length === 1050,
        "The file-only listing hit a transport cap."
      );
    },
  },
  {
    op: "checkout.preview",
    id: "checkout.preview/text",
    async run({ runner, session }) {
      const result = await runner.call("checkout.preview", {
        target: { session },
        path: readPath,
      });
      expect(
        result.kind === "text" && result.text === readText,
        "The preview was incomplete."
      );
    },
  },
  {
    op: "checkout.index",
    id: "checkout.index/paths",
    async run({ runner, session }) {
      const result = await runner.call("checkout.index", {
        target: { session },
        generation: "checkout-reads",
      });
      expect(
        result.paths.includes(readPath),
        "The checkout index missed a file."
      );
    },
  },
  {
    op: "checkout.stats",
    id: "checkout.stats/exclusions",
    async run({ runner, session, seed }) {
      await seed("checkout-reads/exclude.txt", "excluded\n");
      const result = await runner.call("checkout.stats", {
        target: { session },
        base: "main",
        uncommitted: true,
        exclude: ["/exclude[.]txt$/"],
      });
      expect(
        result &&
          result.files - result.excluded.files === 1 &&
          result.added - result.excluded.added === 1,
        "Stats ignored the requested exclusion."
      );
    },
  },
  {
    op: "checkout.diff",
    id: "checkout.diff/exclusions",
    async run({ runner, session }) {
      const input = {
        target: { session },
        base: "main",
        uncommitted: true,
        whitespace: "show",
        exclude: ["/exclude[.]txt$/"],
      } as const;
      const result = await runner.call("checkout.diff", {
        ...input,
        exclude: [...input.exclude],
      });
      expect(
        result &&
          "files" in result &&
          result.files.some(
            (file) =>
              file.path === "checkout-reads/exclude.txt" && file.excluded
          ) &&
          result.files.some((file) => file.path === readPath && !file.excluded),
        "Diff ignored the requested exclusion."
      );
      const selected = await runner.call("checkout.diff", {
        ...input,
        exclude: [...input.exclude],
        path: "checkout-reads/exclude.txt",
      });
      expect(
        selected && "diff" in selected && selected.diff.includes("+excluded"),
        "The single-file patch was missing."
      );
    },
  },
  {
    op: "checkout.changes",
    id: "checkout.changes/files",
    async run({ runner, session }) {
      const result = await runner.call("checkout.changes", {
        target: { session },
        base: "main",
      });
      expect(
        result.files.includes(readPath) &&
          /^[a-f0-9]{64}$/.test(result.stateId),
        "Owner-review changes were incomplete."
      );
    },
  },
  {
    op: "checkout.image",
    id: "checkout.image/bytes",
    async run({ runner, session, seed }) {
      // Larger than one v1 reply line once base64-encoded.
      const content = "image bytes ".repeat(100_000);
      await seed("checkout-reads/pixel.png", content);
      const result = await runner.call("checkout.image", {
        target: { session },
        base: "main",
        uncommitted: true,
        path: "checkout-reads/pixel.png",
        side: "new",
      });
      expect(
        Buffer.from(result.bytes, "base64").toString("utf8") === content,
        "The image bytes were cut short or changed."
      );
      await rejectsWith(
        runner.call("checkout.image", {
          target: { session },
          base: "main",
          uncommitted: true,
          path: "checkout-reads/none.png",
          side: "new",
        }),
        "not_found"
      );
    },
  },
  {
    op: "checkout.defaultFiles",
    id: "checkout.defaultFiles/listing",
    async run({ runner, session }) {
      const result = await runner.call("checkout.defaultFiles", {
        target: { session },
        dirs: [".agents/personas"],
        wait: true,
      });
      expect(
        result.hasOrigin || (result.files.length === 0 && !result.refreshing),
        "A checkout without an origin listed default-branch files."
      );
    },
  },
  {
    op: "checkout.watch",
    id: "checkout.watch/pulses",
    async run({ runner, session, seed }) {
      const { channel } = await runner.open("checkout.watch", {
        target: { session },
      });
      try {
        let pulses = 0;
        let closed = false;
        channel.onData(() => pulses++);
        channel.onClose(() => (closed = true));
        const until = async (done: () => boolean, message: string) => {
          for (let i = 0; i < 100 && !done(); i++)
            await new Promise((resolve) => setTimeout(resolve, 100));
          expect(done(), message);
        };
        // One pulse once the watch is set up, then one for the change.
        await until(() => pulses >= 1, "The watch never reported in.");
        const settled = pulses;
        await seed("checkout-reads/watched.txt", "changed\n");
        await until(
          () => pulses > settled,
          "The watch missed a change in the checkout."
        );
        expect(!closed, "The watch closed by itself.");
      } finally {
        channel.close();
      }
    },
  },
];

const interactiveTerminal: Scenario = {
  id: "terminal.open/interactive",
  op: "terminal.open",
  async run(fixture) {
    const { info, channel } = await fixture.runner.open("terminal.open", {
      target: { session: fixture.session },
      cols: 91,
      rows: 37,
    });
    try {
      const output = await new Promise<string>((resolve, reject) => {
        let output = "";
        channel.onClose(() =>
          reject(new ScenarioFailure("Terminal closed without an exit event."))
        );
        channel.onData((event) => {
          if (event.type === "output")
            output += Buffer.from(event.data, "base64").toString();
          if (event.type === "exit" && event.code === 7) resolve(output);
          else if (event.type !== "output")
            reject(
              new ScenarioFailure(
                `Unexpected terminal event ${JSON.stringify(event)}`
              )
            );
        });
        channel.write({
          type: "input",
          data: "stty size; pwd; id -u; id -un; exit 7\n",
        });
      });
      const lines = output.replaceAll("\r", "").split("\n");
      const dimensions = lines.indexOf("37 91");
      expect(
        dimensions >= 0,
        "The PTY did not start at the requested dimensions."
      );
      expect(
        lines[dimensions + 1] === info.cwd,
        "Terminal started outside the bound checkout."
      );
      expect(
        Number(lines[dimensions + 2]) > 0,
        "Terminal shell did not run as a non-root user."
      );
      expect(
        lines[dimensions + 3] === info.user,
        "Terminal did not report the workload user."
      );
    } finally {
      channel.close();
    }
  },
};

const putFile: Scenario = {
  id: "files.put/bytes",
  op: "files.put",
  async run({ runner, session }) {
    const contents = "put contents ✓\n";
    const blob = Buffer.from(contents).toString("base64");
    const name = "put (1).txt";
    const { path } = await runner.call("files.put", {
      session,
      name,
      size: Buffer.byteLength(contents),
      digest: createHash("sha256").update(contents).digest("hex"),
      blob,
    });
    expect(
      displayPath(path).endsWith(`/${name}`),
      `files.put returned ${displayPath(path)}.`
    );
    const file = await runner.call("files.get", {
      session,
      path: displayPath(path),
    });
    expect(file.blob === blob, "files.get read other bytes at the path.");
  },
};

const runnerGitQueries: Scenario[] = [
  {
    op: "git.defaultBranch",
    id: "git.defaultBranch/checkout-path",
    async run({ runner, session }) {
      const binding = await runner.call("workspace.describe", { session });
      const { branch } = await runner.call("git.defaultBranch", {
        target: { path: binding.path },
      });
      expect(branch === "main", "The path's default branch was not found.");
    },
  },
  {
    op: "git.branches",
    id: "git.branches/session-origin",
    async run({ workspace }) {
      expect(workspace, "Missing managed runner fixture.");
      const { runner, repository } = workspace;
      const session = sessionFromWire("branch-query");
      await runner.call("workspace.prepare", {
        session,
        source: {
          repository,
          checkout: { kind: "new", branch: "branch-query" },
        },
        copyIgnored: [],
        installDependencies: false,
      });
      const { branches } = await runner.call("git.branches", {
        target: { session },
      });
      expect(
        branches.includes("main") && !branches.includes("branch-query"),
        "The branch picker did not read the origin."
      );
    },
  },
  {
    op: "git.base",
    id: "git.base/fallback",
    async run({ runner, session }) {
      const { base } = await runner.call("git.base", {
        target: { session },
        requested: "branch-does-not-exist",
        fallback: ["main"],
      });
      expect(base === "main", "The Git base did not resolve the fallback.");
    },
  },
];

const workspacePreparation: Scenario[] = [
  {
    op: "workspace.prepare",
    id: "workspace.prepare/repository",
    async run({ runner: configured, workspace }) {
      expect(workspace, "Missing managed runner fixture.");
      const { runner, repository } = workspace;
      const session = sessionFromWire("prepare-new");
      await rejectsWith(
        configured.call("workspace.resume", { session }),
        "unsupported"
      );
      const request = {
        session,
        source: { repository, checkout: { kind: "new", branch: "feature" } },
        copyIgnored: [],
        installDependencies: true,
      } satisfies Req<"workspace.prepare">;
      const phases: string[] = [];
      let installed = false;
      const result = await runner.call("workspace.prepare", request, {
        onEvent: (event) => {
          phases.push(event.phase);
          if (event.phase === "dependencies" && event.status === "done")
            installed = event.detail === "npm install completed";
        },
      });
      expect(
        result.branch === "feature" && result.worktree?.base === "main",
        "Wrong branch or base."
      );
      expect(
        phases.includes("copy") && installed && phases.at(-1) === "ready",
        "Missing preparation progress."
      );
      phases.length = 0;
      const repeat = await runner.call("workspace.prepare", request, {
        onEvent: (event) => {
          phases.push(event.phase);
        },
      });
      expect(
        repeat.path === result.path && phases.join() === "ready",
        "Repeat did not reuse its receipt."
      );
      await rejectsWith(
        runner.call("workspace.prepare", {
          ...request,
          source: { repository, checkout: { kind: "branch", branch: "main" } },
        }),
        "conflict"
      );
      await workspace.proveIsolation(session, displayPath(result.path));
      const reused = await runner.call("workspace.prepare", {
        ...request,
        session: sessionFromWire("prepare-reuse"),
        source: { repository, checkout: { kind: "branch", branch: "feature" } },
        installDependencies: false,
      });
      expect(
        reused.branch === "feature" && reused.path !== result.path,
        "Removal left the branch registered to the old worktree."
      );
    },
  },
  {
    op: "workspace.prepare",
    id: "workspace.prepare/directory-and-relaunch",
    async run({ runner: configured, session: configuredSession, workspace }) {
      expect(workspace, "Missing managed runner fixture.");
      const source = await configured.call("workspace.describe", {
        session: configuredSession,
      });
      const { runner } = workspace;
      const session = sessionFromWire("directory-worktree");
      const prepared = await runner.call("workspace.prepare", {
        session,
        source: { directory: pathFromWire(displayPath(source.path)) },
        worktree: {
          name: "directory-worktree",
          create: true,
          branch: "directory-worktree",
          base: "main",
        },
        copyIgnored: [],
        installDependencies: false,
      });
      expect(
        prepared.origin === null && prepared.path !== source.path,
        "Preparing from the current directory required an origin."
      );
      try {
        await runner.call("session.launch", launchRequest(session));
        await runner.call("session.stop", { session, force: true });
        await runner.call("session.launch", launchRequest(session));
        const attached = await runner.call("workspace.describe", { session });
        expect(attached.path === prepared.path, "Relaunch switched checkouts.");
      } finally {
        await runner.call("session.stop", { session, force: true });
        await runner.call("session.discard", { session });
      }
    },
  },
  {
    op: "workspace.resume",
    id: "workspace.resume/interrupted",
    async run({ workspace }) {
      expect(workspace, "Missing managed runner fixture.");
      const { runner, repository } = workspace;
      const session = sessionFromWire("prepare-existing");
      expect(
        (await runner.call("workspace.resume", { session })) === null,
        "An unknown session unexpectedly resumed."
      );
      const result = await runner.call("workspace.prepare", {
        session,
        source: { repository, checkout: { kind: "branch", branch: "main" } },
        copyIgnored: [],
        installDependencies: false,
      });
      expect(result.branch === "main", "Wrong existing branch.");
      await workspace.interrupt(session);
      const phases: string[] = [];
      const resumed = await runner.call(
        "workspace.resume",
        { session },
        {
          onEvent: (event) => {
            phases.push(event.phase);
          },
        }
      );
      expect(
        resumed?.path === result.path && resumed.branch === "main",
        "Resume did not recover the checkout."
      );
      expect(
        phases.includes("copy") && phases.at(-1) === "ready",
        "Resume did not finish its recorded worktree."
      );

      // A session launched by the original wire command still uses its old binding.
      const legacy = sessionFromWire("legacy-scratch");
      await runner.call("session.launch", launchRequest(legacy));
      try {
        const legacyBinding = await runner.call("workspace.resume", {
          session: legacy,
        });
        expect(
          legacyBinding?.worktree === undefined && !!legacyBinding?.path,
          "Legacy binding was replaced."
        );
        expect(
          (await runner.call("session.alive", { session: legacy })).state ===
            "live",
          "Legacy host stopped during resume."
        );
        await runner.call("session.stop", { session: legacy, force: true });
        await runner.call("session.launch", launchRequest(legacy));
        expect(
          (await runner.call("workspace.describe", { session: legacy }))
            .path === legacyBinding.path,
          "Restart changed the legacy checkout."
        );
        const current = await runner.call("git.defaultBranch", {
          target: { session: legacy },
        });
        expect(current.branch === null, "Legacy scratch checkout read failed.");
      } finally {
        await runner.call("session.stop", { session: legacy, force: true });
        await runner.call("session.discard", { session: legacy });
      }
    },
  },
];

const workspaceRelease: Scenario = {
  op: "workspace.release",
  id: "workspace.release/owned-and-protected",
  async run({ runner, session, workspace }) {
    expect(workspace, "Missing managed runner fixture.");
    await workspace.proveRelease(runner, session);
  },
};

export const remoteScenarios: readonly Scenario[] = [
  workspaceRelease,
  ...checkoutReads,
  ...runnerGitQueries,
  ...workspacePreparation,
  interactiveTerminal,
  putFile,
  ...scenarios.filter(
    ({ op }) =>
      op !== interactiveTerminal.op &&
      op !== putFile.op &&
      op !== workspaceRelease.op &&
      !runnerGitQueries.some((scenario) => scenario.op === op) &&
      !checkoutReads.some((scenario) => scenario.op === op) &&
      !workspacePreparation.some((scenario) => scenario.op === op)
  ),
];
