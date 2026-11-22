// Moving between main and the head with agents alive (the four upgrades in E7).
//
// Main's column is always main to main, so it is what a user of main sees when
// they update. The oracle is the client of the server's update protocol, as
// the platform helper is: it signs, fences, swaps the binary and proves
// readiness. It never imitates the product's own half.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { repository } from "../build.mjs";
import { HarnessError } from "../world.mjs";
import {
  agentPath,
  agentRow,
  archive,
  blocksPath,
  prompt,
  startAgain,
  stop,
  streamRows,
  toolNames,
  toolsFile,
  waitForTurns,
  waitForTurnStart,
} from "./support.mjs";

const { version: VERSION } = createRequire(join(repository, "package.json"))(
  join(repository, "package.json")
);
const PREFIX = "/api/v1/system/update-recovery/";

const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .filter((key) => value[key] !== undefined)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

class Update {
  constructor(w) {
    this.w = w;
    this.id = randomUUID();
    this.nonce = randomBytes(32).toString("hex");
    this.directory = join(w.paths.state, "update-recovery");
    this.receipt = join(this.directory, "resume-hosts.json");
    this.key = randomBytes(32).toString("hex");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.directory, "control.key"), this.key, {
      mode: 0o600,
    });
    w.secrets.add(this.key);
    w.secrets.add(this.nonce);
  }

  async send(method, route, input, secret = {}) {
    const challenge = randomBytes(32).toString("hex");
    const reply = await this.w.api(
      method,
      PREFIX + route,
      { ...input, challenge },
      {
        headers: { authorization: `Dispatch-Recovery ${this.key}` },
        timeout: 90_000,
      }
    );
    if (!reply.body || typeof reply.body !== "object") return reply;
    const { proof, ...body } = reply.body;
    const signedRoute =
      method === "DELETE" && route === "fence" ? "fence-abort" : route;
    const expected = createHmac("sha256", this.key)
      .update(
        `dispatch-recovery-v1\n${PREFIX + signedRoute}\n${challenge}\n${canonical(body)}\n${canonical(secret)}`
      )
      .digest("hex");
    return { status: reply.status, body, proofValid: proof === expected };
  }

  fence() {
    return this.send("POST", "fence", { transactionId: this.id });
  }

  abort() {
    return this.send("DELETE", "fence", { transactionId: this.id });
  }

  readiness() {
    return this.send(
      "POST",
      "readiness",
      {
        transactionId: this.id,
        nonce: this.nonce,
        instanceId: "parity-instance",
        expectedVersion: VERSION,
      },
      { nonce: this.nonce }
    );
  }

  probation() {
    return {
      DISPATCH_RECOVERY_PROBATION: "1",
      DISPATCH_RECOVERY_TRANSACTION_ID: this.id,
      DISPATCH_RECOVERY_NONCE: this.nonce,
      DISPATCH_RECOVERY_INSTANCE_ID: "parity-instance",
      DISPATCH_RECOVERY_EXPECTED_VERSION: VERSION,
    };
  }

  resumeReceipt() {
    if (!existsSync(this.receipt)) return null;
    const receipt = JSON.parse(readFileSync(this.receipt, "utf8"));
    // A set. Its order is that of the random agent directory names.
    return {
      ...receipt,
      agents: Object.fromEntries(
        receipt.agents.map((entry) => [entry.id, entry])
      ),
    };
  }
}

function hostPid(w, id) {
  try {
    return Number(
      readFileSync(join(w.paths.agents, id, "host.pid"), "utf8").trim()
    );
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sessionOf(w, id) {
  const [row] = await w.sql(
    "SELECT status, cli_session_id, last_error FROM agents WHERE id = $1",
    [id]
  );
  return row;
}

async function waitForRunning(w, ids) {
  // A resume that fails is an outcome to compare, so do not insist.
  await w.poll(async () => {
    const rows = await w.sql("SELECT status FROM agents WHERE id = ANY($1)", [
      ids,
    ]);
    return rows.every(({ status }) => ["running", "error"].includes(status));
  }, "agents to be running");
  await w.quiet(1500);
}

async function oldInstall(w) {
  const repo = await w.repo(
    "repo",
    {
      ".dispatch/tools.json": toolsFile([
        { name: "echo", description: "Echo", command: ["echo", "ok"] },
      ]),
    },
    { origin: true }
  );
  const idle = await w.agent({ cwd: repo });
  const busy = await w.agent({
    cwd: repo,
    useWorktree: true,
    worktreeBranch: "upgrade",
  });
  await prompt(w, idle, "before the update");
  return { repo, idle, busy };
}

async function driveStopArchive(w, label, id) {
  w.record(`${label}: agent`, await w.api("GET", agentPath(id)));
  w.record(`${label}: post`, await prompt(w, id, `driving ${label}`));
  w.record(`${label}: config`, await w.api("GET", agentPath(id, "/config")));
  w.record(
    `${label}: set model`,
    await w.api("PUT", agentPath(id, "/config"), {
      configId: "model",
      value: "other-model",
    })
  );
  w.record(`${label}: tools`, await toolNames(w, id));
  w.record(`${label}: repo tool`, await w.call(id, "repo_echo"));
  const pid = hostPid(w, id);
  w.record(`${label}: stop`, await stop(w, id));
  w.record(`${label}: host alive after stop`, alive(pid));
  w.record(`${label}: start`, await startAgain(w, id));
  w.record(`${label}: post after start`, await prompt(w, id, `again ${label}`));
  const last = hostPid(w, id);
  w.record(`${label}: archive`, await archive(w, id));
  w.record(`${label}: host alive after archive`, alive(last));
}

/** Hosts started by `from` carry on under `to`, one idle and one mid-turn. */
function handOver(from, to) {
  return async (w) => {
    await w.start(from(w));
    const { repo, idle, busy } = await oldInstall(w);
    await w.api("POST", blocksPath(busy), { text: "sleep:8000" });
    await waitForTurnStart(w, busy, 0);
    const hosts = [hostPid(w, idle), hostPid(w, busy)];
    await w.restart(to(w));
    w.record("hosts survive the swap", hosts.map(alive));
    await waitForTurns(w, busy, 1);
    await w.quiet();
    w.record("hosts after attach", [
      hostPid(w, idle) === hosts[0],
      hostPid(w, busy) === hosts[1],
    ]);
    w.record("idle session", await sessionOf(w, idle));
    w.record("busy session", await sessionOf(w, busy));
    await driveStopArchive(w, "idle host", idle);
    await driveStopArchive(w, "busy host", busy);
    w.record("stream", await streamRows(w));
    w.record("git", await w.gitState(repo));
  };
}

export const upgrades = [
  {
    name: "upgrade-main-host-under-head",
    title: "A host started by main: the head attaches, drives, stops, archives",
    manualStart: true,
    run: handOver(
      () => "main",
      (w) => w.side
    ),
  },
  {
    name: "upgrade-rollback-head-host-under-main",
    title: "A rollback to main with a host the head started",
    manualStart: true,
    run: handOver(
      (w) => w.side,
      () => "main"
    ),
  },
  {
    name: "upgrade-main-state-kept",
    title: "State main wrote: models, Brain, jobs, templates, worktrees, files",
    manualStart: true,
    async run(w) {
      await w.start("main");
      const { repo, idle, busy } = await oldInstall(w);
      await w.call(idle, "brain_store_object", {
        collection: "parity",
        name: "fact",
        value: { from: "main" },
      });
      await w.call(idle, "create_job", {
        name: "from-main",
        directory: repo,
        prompt: "Job.",
      });
      await w.call(idle, "create_template", {
        name: "from-main",
        directory: repo,
        prompt: "Template.",
      });
      await w.upload(agentPath(idle, "/files"), {
        file: { name: "kept.txt", type: "text/plain", bytes: "kept\n" },
      });
      await w.sql(
        "INSERT INTO settings (key, value) VALUES ('agent_models:claude', $1)",
        [
          JSON.stringify({
            models: [{ id: "main-learned", label: "Main Learned" }],
            defaultModel: "main-learned",
            seenAt: "2026-01-02T03:04:05.000Z",
          }),
        ]
      );
      await stop(w, busy);
      await w.restart();
      await w.quiet(1500);
      w.record("models", await w.api("GET", "/api/v1/agent-models"));
      w.record(
        "brain",
        await w.call(idle, "brain_get_object", {
          collection: "parity",
          name: "fact",
        })
      );
      w.record("jobs", await w.call(idle, "list_jobs", { directory: repo }));
      w.record(
        "templates",
        await w.call(idle, "list_templates", { directory: repo })
      );
      w.record("files", await w.call(idle, "list_files"));
      w.record("stopped agent starts", await startAgain(w, busy));
      const [tree, row] = [
        (await agentRow(w, busy)).worktree_path,
        await sessionOf(w, busy),
      ];
      w.record("stopped agent session", row);
      w.record(
        "worktree status",
        await w.api("GET", agentPath(busy, "/worktree-status"))
      );
      w.record("worktree archive", await archive(w, busy));
      w.record("worktree remains", existsSync(tree));
      w.record("git", await w.gitState(repo));
    },
  },
  {
    name: "upgrade-protected",
    title: "A protected update from main, with busy and then idle agents",
    manualStart: true,
    async run(w) {
      await w.start("main");
      const { idle, busy } = await oldInstall(w);
      const update = new Update(w);
      await w.api("POST", blocksPath(busy), { text: "sleep:5000" });
      await waitForTurnStart(w, busy, 0);
      const before = [hostPid(w, idle), hostPid(w, busy)];
      w.record("fence while busy", await update.fence());
      w.record("hosts after a refused fence", before.map(alive));
      await waitForTurns(w, busy, 1);
      await w.quiet(1500);
      const sessions = [await sessionOf(w, idle), await sessionOf(w, busy)];

      const fenced = await update.fence();
      w.record("fence", fenced);
      if (fenced.status !== 200)
        throw new HarnessError("Main did not fence idle agents");
      w.record("hosts after the fence", before.map(alive));
      w.record("receipt", update.resumeReceipt());
      w.record(
        "write while fenced",
        await w.api("POST", blocksPath(idle), { text: "refused" })
      );

      await w.stop();
      await w.start(w.side, update.probation());
      w.record("read during probation", await w.api("GET", "/api/v1/agents"));
      w.record("readiness", await update.readiness());
      w.record("receipt after probation", update.resumeReceipt());

      await w.restart();
      await waitForRunning(w, [idle, busy]);
      w.record("receipt after commit", update.resumeReceipt());
      const resumed = [await sessionOf(w, idle), await sessionOf(w, busy)];
      w.record("resumed", resumed);
      w.record(
        "same sessions",
        resumed.map(
          (row, index) => row.cli_session_id === sessions[index].cli_session_id
        )
      );
      w.record("idle drives on", await prompt(w, idle, "after the update"));
      w.record("busy drives on", await prompt(w, busy, "after the update"));
      w.record("stream", await streamRows(w));
    },
  },
  {
    name: "upgrade-probation-surviving-hosts",
    title: "Probation over hosts main left running, busy and then idle",
    manualStart: true,
    async run(w) {
      await w.start("main");
      const { idle, busy } = await oldInstall(w);
      await w.api("POST", blocksPath(busy), { text: "sleep:7000" });
      await waitForTurnStart(w, busy, 0);
      const hosts = [hostPid(w, idle), hostPid(w, busy)];
      const update = new Update(w);
      await w.restart(w.side);
      await w.stop();
      await w.start(w.side, update.probation());
      w.record("readiness with a busy host", await update.readiness());
      w.record("hosts with a busy host", hosts.map(alive));
      // The turn ends in the host. Probation never records it.
      let settled;
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(1000);
        settled = await update.readiness();
        if (settled.status === 200) break;
      }
      w.record("readiness once idle", settled);
      w.record("hosts once idle", hosts.map(alive));
      w.record("receipt", update.resumeReceipt());
      await w.restart();
      await waitForRunning(w, [idle, busy]);
      w.record("idle", await sessionOf(w, idle));
      w.record("busy", await sessionOf(w, busy));
      w.record("busy drives on", await prompt(w, busy, "after probation"));
    },
  },
  {
    name: "upgrade-aborted-fence",
    title:
      "An update aborted while fenced: the fenced build resumes its agents",
    async run(w) {
      const { idle, busy } = await oldInstall(w);
      const update = new Update(w);
      await w.quiet(1500);
      const hosts = [hostPid(w, idle), hostPid(w, busy)];
      w.record("fence", await update.fence());
      w.record("hosts after the fence", hosts.map(alive));
      w.record("receipt", update.resumeReceipt());
      w.record("abort", await update.abort());
      w.record("exit for the supervisor", await w.waitForExit());
      await w.stop();
      await w.start();
      await waitForRunning(w, [idle, busy]);
      w.record("idle", await sessionOf(w, idle));
      w.record("busy", await sessionOf(w, busy));
      w.record("receipt afterwards", update.resumeReceipt());
      w.record("drives on", await prompt(w, idle, "after the abort"));
    },
  },
  {
    name: "upgrade-abandoned-trial",
    title: "An update abandoned in the trial: main returns and resumes",
    manualStart: true,
    async run(w) {
      await w.start("main");
      const { idle, busy } = await oldInstall(w);
      const update = new Update(w);
      await w.quiet(1500);
      w.record("fence", await update.fence());
      await w.stop();
      await w.start(w.side, update.probation());
      w.record("readiness", await update.readiness());
      await w.stop();
      rmSync(join(update.directory, "probation.json"), { force: true });
      // No restore: main must also cope with what the trial left behind.
      await w.start("main");
      await waitForRunning(w, [idle, busy]);
      w.record("idle", await sessionOf(w, idle));
      w.record("busy", await sessionOf(w, busy));
      w.record("receipt afterwards", update.resumeReceipt());
      w.record("drives on", await prompt(w, idle, "back on main"));
    },
  },
  {
    name: "upgrade-helper-backup-restore",
    title: "The platform helper's own backup, swap and restore",
    skip: "needs a supervisor the fixture has not got: recovery-apply drives systemd-run, flock, systemctl --user and pg_dump/pg_restore on an enrolled Linux install, and the Mac helper is the signed app under launchd (L5)",
  },
  {
    name: "upgrade-real-engine-resume",
    title: "An upgraded host resumes a real engine's session",
    skip: "needs real Claude, Codex or OpenCode session storage; the oracle uses the fixture adapter and makes no model calls (L5)",
  },
];
