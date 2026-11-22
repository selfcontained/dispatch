// What a local user does with a session, end to end.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentFiles,
  agentPath,
  agentRow,
  archive,
  blocksPath,
  markerScript,
  MiB,
  persona,
  PNG,
  prompt,
  startAgain,
  stop,
  streamRows,
  toolsFile,
  turnCount,
  waitForTurns,
  waitForTurnStart,
} from "./support.mjs";

export const sessions = [
  {
    name: "session-lifecycle",
    title: "Create, prompt, read, rename, stop, start, archive",
    async run(w) {
      const cwd = await w.repo("repo");
      const { id, response } = await w.createAgent({ cwd });
      w.record("create", response);
      w.record("agent", await w.api("GET", agentPath(id)));
      w.record("list", await w.api("GET", "/api/v1/agents"));
      w.record("host files at launch", agentFiles(w, id));
      w.record("post", await prompt(w, id, "hello"));
      w.record("feed", await w.api("GET", blocksPath(id)));
      for (const route of [
        "/identity",
        "/config",
        "/commands",
        "/permissions",
        "/background-work",
        "/mcp-inventory",
        "/chat-location",
        "/turn",
        "/repo-icon",
        "/files",
      ])
        w.record(`GET ${route}`, await w.api("GET", agentPath(id, route)));
      w.record(
        "git contexts",
        await w.api("GET", `/api/v1/agents/git-context?ids=${id}`)
      );
      w.record(
        "set model",
        await w.api("PUT", agentPath(id, "/config"), {
          configId: "model",
          value: "other-model",
        })
      );
      await w.quiet();
      w.record(
        "rename",
        await w.api("PATCH", agentPath(id, "/name"), { name: "renamed" })
      );
      w.record("stop", await stop(w, id));
      w.record("stopped", await w.api("GET", agentPath(id)));
      w.record(
        "post while stopped",
        await w.api("POST", blocksPath(id), { text: "while stopped" })
      );
      w.record("start", await startAgain(w, id));
      w.record("started", await w.api("GET", agentPath(id)));
      w.record("second post", await prompt(w, id, "again"));
      w.record("host files", agentFiles(w, id));
      w.record("stream", await streamRows(w));
      w.record("files root", w.tree(w.paths.files));
      w.record("git", await w.gitState(cwd));
      w.record("archive", await archive(w, id));
      w.record("host files after archive", agentFiles(w, id));
      w.record("files root after archive", w.tree(w.paths.files));
      w.record("after archive", await w.api("GET", agentPath(id)));
      w.record(
        "identity after archive",
        await w.api("GET", agentPath(id, "/identity"))
      );
      w.record("history", await w.api("GET", "/api/v1/history/agents"));
      w.record(
        "history detail",
        await w.api("GET", `/api/v1/history/agents/${id}`)
      );
    },
  },
  {
    name: "session-tool-surface",
    title: "The MCP tools a local agent sees, with schemas",
    async run(w) {
      const cwd = await w.repo("repo", {
        ".dispatch/tools.json": toolsFile([
          { name: "echo", description: "Echo", command: ["echo", "ok"] },
        ]),
      });
      const id = await w.agent({ cwd });
      w.record("agent route", await w.listTools(id));

      // The job route, through a real run of a job.
      const created = await w.api("POST", "/api/v1/jobs", {
        name: "parity-job",
        directory: cwd,
        prompt: "sleep:8000",
        agentType: "codex",
      });
      w.record("job", created);
      w.record(
        "job run",
        await w.api("POST", "/api/v1/jobs/run", {
          name: "parity-job",
          directory: cwd,
          jobId: created.body?.job?.id ?? created.body?.id,
          wait: false,
        })
      );
      const job = await w.poll(async () => {
        const [row] = await w.sql(
          "SELECT id FROM agents WHERE id <> $1 AND status = 'running' AND cli_session_id IS NOT NULL",
          [id]
        );
        return row?.id;
      }, "the job's agent");
      w.agents.push(job);
      w.record("job route", await w.listTools(job));
      w.record(
        "job complete",
        await w.call(job, "job_complete", {
          report: {
            status: "completed",
            summary: "Done",
            tasks: [{ name: "fixture", status: "success", summary: "Done" }],
          },
        })
      );
    },
  },
  {
    name: "session-engines",
    title: "Claude and OpenCode: launch, plans, sub-agents, permissions",
    async run(w) {
      const cwd = await w.repo("repo");
      const claude = await w.agent({ cwd, type: "claude" });
      w.record("claude launch", agentFiles(w, claude)?.launch);
      w.record("claude turn", await prompt(w, claude, "tasks: subagent: go"));

      const codex = await w.agent({ cwd, type: "codex", fullAccess: true });
      w.record("codex full access launch", agentFiles(w, codex)?.launch);

      const opencode = await w.createAgent({
        cwd,
        type: "opencode",
        fullAccess: true,
      });
      w.record("opencode", opencode.response);
      if (opencode.id)
        w.record("opencode launch", agentFiles(w, opencode.id)?.launch);

      const asking = await w.agent({ cwd });
      await w.api("POST", blocksPath(asking), { text: "permission-test" });
      const pending = await w.poll(async () => {
        const reply = await w.api("GET", agentPath(asking, "/permissions"));
        const requests = reply.body?.requests ?? reply.body?.permissions;
        return requests?.length && { reply, request: requests[0] };
      }, "a permission request");
      w.record("permission", pending.reply);
      w.record(
        "permission answer",
        await w.api(
          "POST",
          agentPath(
            asking,
            `/permissions/${pending.request.requestId ?? pending.request.id}`
          ),
          { optionId: "once" }
        )
      );
      await waitForTurns(w, asking, 1);
      await w.quiet();
      w.record("stream", await streamRows(w));
    },
  },
  {
    name: "session-turn-control",
    title: "Queue, cancel and stop during a turn",
    async run(w) {
      const cwd = await w.repo("repo");
      const id = await w.agent({ cwd });
      w.record(
        "long post",
        await w.api("POST", blocksPath(id), { text: "sleep:3000" })
      );
      await waitForTurnStart(w, id, 0);
      w.record("busy agent", await w.api("GET", agentPath(id)));
      w.record(
        "queued post",
        await w.api("POST", blocksPath(id), {
          text: "queued",
          delivery: "queue",
        })
      );
      await waitForTurns(w, id, 2);
      await w.quiet();

      await w.api("POST", blocksPath(id), { text: "sleep:20000" });
      await waitForTurnStart(w, id, 2);
      w.record(
        "cancel",
        await w.api("POST", agentPath(id, "/runtime/cancel"), {})
      );
      await waitForTurns(w, id, 3);
      await w.quiet();

      await w.api("POST", blocksPath(id), { text: "sleep:20000" });
      await waitForTurnStart(w, id, 3);
      w.record("stop while busy", await stop(w, id));
      w.record("stream", await streamRows(w));
      w.record("agent", await w.api("GET", agentPath(id)));
    },
  },
  {
    name: "session-restart-reattach",
    title: "A server restart with idle and busy hosts",
    async run(w) {
      const cwd = await w.repo("repo");
      const idle = await w.agent({ cwd });
      const busy = await w.agent({ cwd });
      await prompt(w, idle, "before the restart");
      await w.api("POST", blocksPath(busy), { text: "sleep:6000" });
      await waitForTurnStart(w, busy, 0);
      await w.restart();
      await waitForTurns(w, busy, 1);
      await w.quiet();
      w.record("idle", await w.api("GET", agentPath(idle)));
      w.record("busy", await w.api("GET", agentPath(busy)));
      w.record(
        "post after restart",
        await prompt(w, idle, "after the restart")
      );
      w.record("stream", await streamRows(w));
    },
  },
  {
    name: "session-create-validation",
    title: "What create accepts and refuses",
    async run(w) {
      const repo = await w.repo("repo", { "nested/file.txt": "nested\n" });
      const plain = w.path("plain");
      w.write(w.paths.work, {
        "plain/a.txt": "a\n",
        "a-file": "file\n",
        "repo-link": { link: repo },
      });
      const cases = {
        "missing folder": { cwd: w.path("nowhere") },
        "a file": { cwd: w.path("a-file") },
        relative: { cwd: "work/repo" },
        "home tilde": { cwd: "~" },
        "trailing slash": { cwd: `${repo}/` },
        subdirectory: { cwd: join(repo, "nested") },
        "through a symlink": { cwd: w.path("repo-link") },
        empty: { cwd: "" },
        "outside git": { cwd: plain },
        "worktree outside git": { cwd: plain, useWorktree: true },
        "worktree from a subdirectory": {
          cwd: join(repo, "nested"),
          useWorktree: true,
          worktreeBranch: "from-nested",
        },
        "bad branch": {
          cwd: repo,
          useWorktree: true,
          worktreeBranch: "has space",
        },
        "missing base": {
          cwd: repo,
          useWorktree: true,
          baseBranch: "no-such-branch",
          worktreeBranch: "from-missing",
        },
        "unknown engine": { cwd: repo, type: "nonesuch" },
        "unknown model": { cwd: repo, model: "no-such-model" },
        "unknown effort": { cwd: repo, effort: "no-such-effort" },
        "unknown parent": { cwd: repo, parentAgentId: "agt_000000000000" },
        "unknown project": { cwd: repo, projectId: "no-such-project" },
      };
      for (const [label, body] of Object.entries(cases)) {
        const { id, response } = await w.createAgent(body);
        w.record(label, response);
        if (id) w.record(`${label}: settled`, await agentRow(w, id));
      }
    },
  },
  {
    name: "session-stop-hook",
    title: "The stop hook runs where main runs it",
    async run(w) {
      const marker = (name) => join(w.root, `hook-${name}`);
      const hook = (name) =>
        toolsFile([], { stop: { command: [w.path(`${name}.sh`)] } });
      const names = ["nested", "moved-from", "moved-to", "worktree"];
      w.write(
        w.paths.work,
        Object.fromEntries(
          names.map((name) => [`${name}.sh`, markerScript(marker(name))])
        )
      );
      const nested = await w.repo("nested", {
        ".dispatch/tools.json": hook("nested"),
        "inner/file.txt": "inner\n",
      });
      const from = await w.repo("from", {
        ".dispatch/tools.json": hook("moved-from"),
      });
      const to = await w.repo("to", {
        ".dispatch/tools.json": hook("moved-to"),
      });
      const based = await w.repo("based", {
        ".dispatch/tools.json": hook("worktree"),
      });

      const inner = await w.agent({ cwd: join(nested, "inner") });
      const moved = await w.agent({ cwd: from });
      await w.call(moved, "set_workspace", { path: to });
      const tree = await w.agent({
        cwd: based,
        useWorktree: true,
        worktreeBranch: "hooked",
      });
      for (const id of [inner, moved, tree]) await stop(w, id);
      for (const name of names)
        w.record(`${name} hook ran`, existsSync(marker(name)));
    },
  },
  {
    name: "session-stop-hook-timeout",
    title: "A stop hook past 15 seconds is abandoned as on main",
    waits: true,
    async run(w) {
      const marker = join(w.root, "hook-child-finished");
      w.write(w.paths.work, {
        "hook.sh": {
          run: `#!/bin/sh\n(sleep 18; echo done > "${marker}") &\nsleep 17\n`,
        },
      });
      const cwd = await w.repo("repo", {
        ".dispatch/tools.json": toolsFile([], {
          stop: { command: [w.path("hook.sh")] },
        }),
      });
      const id = await w.agent({ cwd });
      w.record("stop", await stop(w, id));
      await sleep(8000);
      w.record("hook's child survived", existsSync(marker));
    },
  },
  {
    name: "session-attachments",
    title: "Attachments reach the agent as on main",
    async run(w) {
      const cwd = await w.repo("repo");
      const id = await w.agent({ cwd });
      const files = {
        text: {
          name: "notes.txt",
          type: "text/plain",
          bytes: "native composer text",
        },
        image: { name: "pixel.png", type: "image/png", bytes: PNG },
        spaces: {
          name: "two words (1).md",
          type: "text/markdown",
          bytes: "# words\n",
        },
        large: {
          name: "large.txt",
          type: "text/plain",
          bytes: "a".repeat(2 * MiB),
        },
      };
      for (const [label, file] of Object.entries(files)) {
        const upload = await w.upload(agentPath(id, "/files"), {
          file,
          fields: { source: "user" },
        });
        w.record(`${label}: upload`, upload);
        const fileId = upload.body?.file?.id;
        if (!fileId) continue;
        w.record(
          `${label}: post`,
          await prompt(w, id, `attached ${label}`, {
            attachments: [{ type: "file", fileId }],
          })
        );
        w.record(`${label}: fetch`, await w.api("GET", upload.body.file.url));
      }
      w.record("listed", await w.call(id, "list_files"));
      w.record("stream", await streamRows(w));
      w.record("journal", agentFiles(w, id)?.journal);
      w.record("clipboard writes", {
        osascript: w.shimCalls("osascript"),
        pbcopy: w.shimCalls("pbcopy"),
        xclip: w.shimCalls("xclip"),
      });
    },
  },
  {
    name: "session-children",
    title: "Child agents, persona launches and agent lists",
    async run(w) {
      const cwd = await w.repo("repo", {
        ".agents/personas/keeper.md": persona("Keeper"),
        ".agents/personas/builder.md": persona("Builder", "Build.", "task"),
      });
      const parent = await w.agent({ cwd });
      const launches = {
        "same folder": { name: "same", prompt: "child same" },
        "explicit path": { name: "path", prompt: "child path", cwd },
        "worktree on the branch in use": {
          name: "in-use",
          prompt: "child in use",
          useWorktree: true,
        },
        "own worktree": {
          name: "tree",
          createNewBranch: true,
          prompt: "child tree",
          useWorktree: true,
          worktreeBranch: "child-tree",
        },
        "task persona": {
          name: "builder",
          prompt: "child builder",
          persona: "builder",
        },
        "review persona": {
          name: "keeper",
          prompt: "child keeper",
          persona: "keeper",
        },
        "missing folder": {
          name: "lost",
          prompt: "lost",
          cwd: w.path("none"),
        },
      };
      for (const [label, input] of Object.entries(launches)) {
        const result = await w.call(parent, "launch_agent", input);
        w.record(label, result);
        const child = result.structuredContent?.agentId;
        await w.poll(async () => {
          const [row] = await w.sql(
            "SELECT count(*)::int AS starting FROM agents WHERE status = 'creating'"
          );
          return row.starting === 0;
        }, `${label} launch`);
        await w.quiet(1500);
        if (child) {
          w.record(`${label}: row`, await agentRow(w, child));
          w.record(`${label}: launch`, agentFiles(w, child)?.launch);
        }
      }
      w.record("list_agents", await w.call(parent, "list_agents"));
      w.record("agents", await w.api("GET", "/api/v1/agents"));
      // Children post to their parent concurrently, so compare row counts only.
      w.record("turns of the parent", await turnCount(w, parent));
    },
  },
];
