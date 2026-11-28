import { targetMatrix } from "./target-matrix.js";
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
import {
  CONFORMANCE_OWNER,
  launchRequest,
  promptSession,
  replay,
  turnText,
} from "./session.js";
import { OPERATION_TASK, SCENARIO_TASK } from "./tasks.js";

export type LaneFixture = {
  /** Already wrapped with `checked`. */
  runner: Runner;
  /** A session whose current checkout `seed` writes into. */
  session: SessionHandle;
  /** Writes a file at a relative path in the session's checkout. */
  seed(path: string, content: string): Promise<void>;
  github?: { signedIn(value: boolean): Promise<void> };
  workspace?: {
    runner: Runner;
    repository: string;
    selectionDirectory?: string;
    /** Remote's fixed-directory fixture disables repository resume; local enables it. */
    configuredResume?: "empty" | "unsupported";
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
    mode: "command-manifest",
    encoding: "utf8",
    maxBytes: null,
  });
  expect(file?.data === content, "checkout.read returned other content.");
  expect(file.digest, "checkout.read returned no digest to guard with.");
  return {
    target,
    guard: {
      path: GUARD,
      digest: file.digest,
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
    id: "session.list/owner",
    op: "session.list",
    async run({ runner, session }) {
      const owned = await runner.call("session.list", {
        owner: CONFORMANCE_OWNER,
      });
      expect(
        owned.sessions.some(
          (entry) =>
            entry.session === session &&
            entry.state === "live" &&
            entry.launchId
        ),
        "The list omitted the controller's launch."
      );
      const foreign = await runner.call("session.list", {
        owner: "another-controller",
      });
      expect(
        foreign.sessions.every((entry) => entry.session !== session),
        "The list included a session belonging to another controller."
      );
    },
  },
  {
    id: "session.sample/live",
    op: "session.sample",
    async run({ runner, session }) {
      const { samples } = await runner.call("session.sample", {
        sessions: [session, session, UNKNOWN_SESSION],
      });
      expect(
        samples.length === 1 && samples[0]?.session === session,
        "Expected one sample for the live session."
      );
      const sample = samples[0]!;
      expect(
        sample.supported &&
          sample.error === null &&
          sample.cpuPercent !== null &&
          sample.cpuPercent >= 0 &&
          (sample.rssBytes ?? 0) > 0 &&
          (sample.processCount ?? 0) > 0,
        "Expected CPU and memory for the live host process tree."
      );
    },
  },
  {
    id: "session.sample/empty",
    op: "session.sample",
    async run({ runner }) {
      const { samples } = await runner.call("session.sample", { sessions: [] });
      expect(samples.length === 0, "An empty request returned samples.");
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

// Portable checkout scenarios shared by the local and enrolled child lanes.
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
      let previousIndex = 0;
      for (const diagnostic of result.diagnostics ?? []) {
        expect(
          diagnostic.fileIndex >= previousIndex &&
            diagnostic.fileIndex <= result.files.length,
          "File diagnostics must follow listing order."
        );
        previousIndex = diagnostic.fileIndex;
      }
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
      const { branch, currentBranch } = await runner.call("git.defaultBranch", {
        target: { path: binding.path },
      });
      expect(branch === "main", "The path's default branch was not found.");
      const context = await runner.call("git.context", {
        target: { path: binding.path },
      });
      expect(
        currentBranch === (context?.branch || null),
        "The path's current branch differs from its Git context."
      );
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
      if (workspace.configuredResume === "empty")
        expect(
          (await configured.call("workspace.resume", { session })) === null,
          "An unknown configured session unexpectedly resumed."
        );
      else
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
    },
  },
];

/**
 * `policy: "ownership"` answers who owns the session's checkout without
 * reading its state (no Git status or fetch); absent, the state is read.
 */
export const workspaceObserveOwnership: Scenario = {
  op: "workspace.observe",
  id: "workspace.observe/ownership-reads-no-state",
  async run({ workspace }) {
    expect(workspace, "Missing managed runner fixture.");
    const { runner, repository } = workspace;
    const session = sessionFromWire("observe-ownership");
    await runner.call("workspace.prepare", {
      session,
      source: {
        repository,
        checkout: { kind: "new", branch: "observe-ownership" },
      },
      copyIgnored: [],
      installDependencies: false,
    });
    try {
      const ownership = await runner.call("workspace.observe", {
        session,
        policy: "ownership",
      });
      expect(
        ownership.ownership === "owned" && ownership.checkout === null,
        "An ownership observation read the checkout's state."
      );
      const changes = await runner.call("workspace.observe", { session });
      expect(
        changes.ownership === "owned" && changes.checkout !== null,
        "An observation without a policy did not read the checkout's state."
      );
    } finally {
      await runner
        .call("workspace.release", {
          session,
          deleteBranch: true,
          originalBranch: "observe-ownership",
        })
        .catch(() => {});
    }
  },
};

const workspaceRelease: Scenario = {
  op: "workspace.release",
  id: "workspace.release/owned-and-protected",
  async run({ runner, session, workspace }) {
    expect(workspace, "Missing managed runner fixture.");
    await workspace.proveRelease(runner, session);
  },
};

/** Offline contract checks: all paths and repositories come from the lane. */
const offlineScenarios: readonly Scenario[] = [
  {
    op: "github.login.cancel",
    id: "github.login.cancel/no-login",
    async run({ runner }) {
      const result = await runner.call("github.login.cancel", {
        requestId: "conformance-cancel",
      });
      expect(
        result.status === "signed-out",
        "Cancelling an absent login changed account state."
      );
    },
  },
  {
    op: "github.logout",
    id: "github.logout/already-signed-out",
    async run({ runner }) {
      for (let i = 0; i < 2; i++) {
        const result = await runner.call("github.logout", {});
        expect(
          result.status === "signed-out",
          "Repeated signed-out logout was not idempotent."
        );
      }
    },
  },
  {
    op: "github.account",
    id: "github.account/signed-out",
    async run({ runner }) {
      const result = await runner.call("github.account", {});
      expect(
        result.status === "signed-out",
        "Isolated GitHub config did not report signed out."
      );
    },
  },
  {
    op: "workspace.describe",
    id: "workspace.describe/binding-and-missing",
    async run({ runner, session }) {
      const binding = await runner.call("workspace.describe", { session });
      expect(
        displayPath(binding.path).startsWith("/"),
        "Binding path must be absolute."
      );
      expect(
        !binding.moved && binding.origin === null,
        "Unexpected initial checkout binding."
      );
      await rejectsWith(
        runner.call("workspace.describe", { session: UNKNOWN_SESSION }),
        "not_found"
      );
    },
  },
  {
    op: "workspace.select",
    id: "workspace.select/move-and-reset",
    async run({ runner, session, seed, workspace }) {
      const before = await runner.call("workspace.describe", { session });
      await seed("offline/nested/file.txt", "nested");
      const selected = await runner.call("workspace.select", {
        session,
        path: pathFromWire(displayPath(before.path) + "/offline/nested"),
      });
      expect(
        selected.path === before.path && !selected.moved,
        "Selecting a Git subdirectory must select its checkout root."
      );
      await rejectsWith(
        runner.call("workspace.select", {
          session,
          path: pathFromWire(displayPath(before.path) + "/offline/missing"),
        }),
        "invalid"
      );
      expect(
        workspace?.selectionDirectory,
        "Missing workspace selection fixture."
      );
      try {
        const moved = await runner.call("workspace.select", {
          session,
          path: pathFromWire(workspace.selectionDirectory),
        });
        expect(
          moved.moved &&
            displayPath(moved.path) === workspace.selectionDirectory,
          "Selecting another directory did not move the session."
        );
        const described = await runner.call("workspace.describe", { session });
        expect(
          described.path === moved.path && described.moved,
          "Selection was not retained in its binding."
        );
      } finally {
        await runner.call("workspace.select", { session, path: null });
      }
      const reset = await runner.call("workspace.select", {
        session,
        path: null,
      });
      expect(
        reset.path === before.path && !reset.moved,
        "Reset changed the original checkout."
      );
    },
  },
  {
    op: "path.resolve",
    id: "path.resolve/existing-and-missing",
    async run({ runner, session }) {
      const binding = await runner.call("workspace.describe", { session });
      const path = displayPath(binding.path);
      const resolved = await runner.call("path.resolve", {
        path,
        git: false,
        canonical: [path, path + "/offline/missing"],
      });
      expect(
        resolved.exists &&
          resolved.isDirectory &&
          resolved.canonicalPath === binding.path &&
          resolved.git === null,
        "Path resolution lost directory identity or ignored git:false."
      );
      expect(
        resolved.canonical?.[0] === binding.path &&
          resolved.canonical[1] === null,
        "Canonical results must retain request order and missing paths."
      );
      const missing = await runner.call("path.resolve", {
        path: path + "/offline/missing",
        git: false,
      });
      expect(
        !missing.exists &&
          !missing.isDirectory &&
          missing.canonicalPath === null,
        "Missing path resolved as present."
      );
    },
  },
  {
    op: "path.complete",
    id: "path.complete/prefix-and-limit",
    async run({ runner, session, seed }) {
      await seed("offline/completion/alpha/file", "a");
      await seed("offline/completion/alpine/file", "b");
      const binding = await runner.call("workspace.describe", { session });
      const prefix = displayPath(binding.path) + "/offline/completion/al";
      const all = await runner.call("path.complete", { prefix, limit: 20 });
      expect(
        all.completions.includes(prefix + "pha") &&
          all.completions.includes(prefix + "pine"),
        "Completion missed matching directories."
      );
      const limited = await runner.call("path.complete", { prefix, limit: 1 });
      expect(
        limited.completions.length === 1 &&
          all.completions.includes(limited.completions[0]!),
        "Completion did not honor its limit."
      );
    },
  },
  {
    op: "checkout.access",
    id: "checkout.access/present-and-missing",
    async run({ runner, session, seed }) {
      await seed("offline/access.txt", "access");
      expect(
        await runner.call("checkout.access", {
          target: { session },
          path: "offline/access.txt",
        }),
        "Existing file was inaccessible."
      );
      expect(
        !(await runner.call("checkout.access", {
          target: { session },
          path: "offline/missing.txt",
        })),
        "Missing file was accessible."
      );
    },
  },
  {
    op: "checkout.write",
    id: "checkout.write/create-update-and-stale",
    async run({ runner, session }) {
      const target = { session };
      const path = "offline/written.txt";
      const data = "created café\n";
      const created = await runner.call("checkout.write", {
        target,
        path,
        data,
        expectedDigest: null,
      });
      expect(
        created.digest === createHash("sha256").update(data).digest("hex"),
        "Write digest differs from bytes."
      );
      const updated = await runner.call("checkout.write", {
        target,
        path,
        data: "updated\n",
        expectedDigest: created.digest,
      });
      await rejectsWith(
        runner.call("checkout.write", {
          target,
          path,
          data: "stale\n",
          expectedDigest: created.digest,
        }),
        "stale"
      );
      const read = await runner.call("checkout.read", {
        target,
        path,
        encoding: "utf8",
        maxBytes: null,
      });
      expect(
        read?.data === "updated\n" && read.digest === updated.digest,
        "Stale write changed committed content."
      );
      await rejectsWith(
        runner.call("checkout.write", {
          target,
          path: "../escape.txt",
          data: "escape",
          expectedDigest: null,
        }),
        "forbidden"
      );
    },
  },
  {
    op: "git.context",
    id: "git.context/bound-checkout",
    async run({ runner, session }) {
      const binding = await runner.call("workspace.describe", { session });
      const context = await runner.call("git.context", { target: { session } });
      expect(
        context?.branch === "main" &&
          context.worktreePath === binding.path &&
          !context.isWorktree,
        "Git context differs from bound primary checkout."
      );
    },
  },
  {
    op: "git.roots",
    id: "git.roots/bound-and-checkout-only",
    async run({ runner, session }) {
      const binding = await runner.call("workspace.describe", { session });
      const roots = await runner.call("git.roots", { target: { session } });
      expect(
        roots.checkoutRoot === binding.path &&
          roots.repositoryRoot === binding.path,
        "Git roots differ from primary checkout."
      );
      const checkout = await runner.call("git.roots", {
        target: { session },
        checkoutOnly: true,
      });
      expect(
        checkout.checkoutRoot === binding.path,
        "Independent checkout probe lost checkout root."
      );
    },
  },
  {
    op: "git.origin",
    id: "git.origin/no-remote",
    async run({ runner, session }) {
      const binding = await runner.call("workspace.describe", { session });
      expect(
        (await runner.call("git.origin", { path: displayPath(binding.path) }))
          .url === null,
        "Origin appeared on a checkout without a remote."
      );
    },
  },
  {
    op: "git.remoteHeads",
    id: "git.remoteHeads/local-bare",
    async run({ runner, workspace }) {
      expect(workspace, "Missing offline repository fixture.");
      const querySession = sessionFromWire("remote-heads-query");
      const prepared = await workspace.runner.call("workspace.prepare", {
        session: querySession,
        source: {
          repository: workspace.repository,
          checkout: { kind: "new", branch: "remote-heads-query" },
        },
        copyIgnored: [],
        installDependencies: false,
      });
      const { branches } = await runner.call("git.remoteHeads", {
        path: displayPath(prepared.path),
      });
      expect(
        branches.includes("main") && new Set(branches).size === branches.length,
        "Bare repository heads were missing or duplicated."
      );
    },
  },
  {
    op: "engine.list",
    id: "engine.list/presence-only",
    async run({ runner }) {
      const { entries } = await runner.call("engine.list", {
        refresh: false,
        include: [],
      });
      expect(
        entries.length > 0 &&
          new Set(entries.map((row) => row.id)).size === entries.length,
        "Engine inventory is empty or duplicated."
      );
      expect(
        entries.every(
          (row) =>
            row.version === null &&
            row.signedIn === null &&
            row.actions.length === 0
        ),
        "Presence-only inventory probed excluded details."
      );
    },
  },
];

const fakeGitHub: Scenario[] = [
  {
    op: "github.account",
    id: "github.account/signed-in-path-only",
    async run({ runner, github }) {
      expect(github, "Missing isolated gh fixture");
      await github.signedIn(true);
      try {
        const account = await runner.call("github.account", {});
        expect(
          account.status === "signed-in" && account.login === "fixture-user",
          "PATH-only gh account was not used"
        );
      } finally {
        await github.signedIn(false);
      }
    },
  },
  {
    op: "github.repositories",
    id: "github.repositories/path-only",
    async run({ runner, github }) {
      expect(github, "Missing isolated gh fixture");
      await github.signedIn(true);
      try {
        const v = await runner.call("github.repositories", { query: "sample" });
        expect(
          v.repositories.length === 1 &&
            v.repositories[0]?.name === "fixture/sample",
          "Wrong PATH-only repository search results"
        );
      } finally {
        await github.signedIn(false);
      }
    },
  },
  {
    op: "github.branches",
    id: "github.branches/path-only",
    async run({ runner, github }) {
      expect(github, "Missing isolated gh fixture");
      await github.signedIn(true);
      try {
        const v = await runner.call("github.branches", {
          owner: "fixture",
          repo: "sample",
        });
        expect(
          v.defaultBranch === "main" && v.branches.includes("feature/fixture"),
          "Wrong PATH-only GitHub branch results"
        );
      } finally {
        await github.signedIn(false);
      }
    },
  },
];

export const remoteScenarios: readonly Scenario[] = [
  ...targetMatrix,
  ...fakeGitHub,
  workspaceRelease,
  workspaceObserveOwnership,
  ...checkoutReads,
  ...offlineScenarios,
  ...runnerGitQueries,
  ...workspacePreparation,
  interactiveTerminal,
  putFile,
  ...scenarios.filter(
    ({ op }) =>
      !fakeGitHub.some(
        (scenario) => scenario.op === op && op !== "github.account"
      ) &&
      op !== interactiveTerminal.op &&
      op !== putFile.op &&
      op !== workspaceRelease.op &&
      op !== workspaceObserveOwnership.op &&
      !runnerGitQueries.some((scenario) => scenario.op === op) &&
      !checkoutReads.some((scenario) => scenario.op === op) &&
      !workspacePreparation.some((scenario) => scenario.op === op) &&
      !offlineScenarios.some((scenario) => scenario.op === op)
  ),
];

/** Every executable remote scenario also runs against the real local child. */
export const localScenarios: readonly Scenario[] = [
  {
    id: "runner.health/success",
    op: "runner.health",
    async run({ runner }) {
      await runner.call("runner.health", {});
    },
  },
  ...remoteScenarios.filter(({ op }) => op !== "runner.health"),
];
