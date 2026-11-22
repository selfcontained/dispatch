// Audit 4.3: the seven local regressions found while tracing the branch.
// `audit-N` in a name is the item's number there.
import { existsSync, linkSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HarnessError } from "../world.mjs";
import {
  agentPath,
  KiB,
  markerScript,
  MiB,
  ownerPlan,
  owners,
  persona,
  personaRoute,
  PNG,
  postFile,
  reviewableRepo,
  stop,
  toolNames,
  toolsFile,
} from "./support.mjs";

const echoTool = toolsFile([
  { name: "echo", description: "Echo", command: ["echo", "ok"] },
]);
const hookManifest = (command, description) =>
  toolsFile([], { stop: { command, ...(description && { description }) } });

export const regressions = [
  {
    name: "audit-1-sharing",
    title: "Post a file by path: any file main could read",
    async run(w) {
      const cwd = await w.repo("repo");
      const parent = await w.agent({ cwd });
      const child = await w.agent({ cwd, parentAgentId: parent });
      const stranger = await w.agent({ cwd });

      const childFile = await w.upload(agentPath(child, "/files"), {
        file: { name: "child.txt", type: "text/plain", bytes: "from child\n" },
      });
      const strangerFile = await w.upload(agentPath(stranger, "/files"), {
        file: { name: "other.txt", type: "text/plain", bytes: "from other\n" },
      });
      w.record(
        "list child files",
        await w.call(parent, "list_files", { ownerAgentId: child })
      );

      const project = await w.api("POST", "/api/v1/projects", {
        name: "Parity",
        color: "#336699",
        repoRoot: cwd,
      });
      const task = await w.upload("/api/v1/tasks", {
        field: "startupFiles",
        fields: {
          projectId: project.body.id ?? project.body.project?.id,
          title: "With attachment",
        },
        file: { name: "brief.txt", type: "text/plain", bytes: "brief\n" },
      });
      w.record("task", task);
      const [attachment] = await w.sql(
        "SELECT * FROM task_attachments LIMIT 1"
      );
      if (!attachment)
        throw new HarnessError("The task attachment fixture was not created");
      const storedTaskFile = attachment
        ? Object.keys(w.tree(w.paths.state)).find(
            (name) =>
              !name.endsWith("/") &&
              name.endsWith(basename(attachment.file_name))
          )
        : undefined;

      w.write(w.paths.work, {
        "plain.txt": "plain\n",
        "big.txt": "a".repeat(21 * MiB),
        "at-limit.txt": "a".repeat(20 * MiB),
        "back\\slash.txt": "backslash\n",
        "line\nbreak.txt": "line break\n",
        "über notes.txt": "unicode\n",
        "sub/inner.txt": "inner\n",
        "up.txt": "up\n",
        "pixel.png": PNG,
      });
      linkSync(w.path("plain.txt"), w.path("hard.txt"));
      w.write(w.paths.work, {
        "link.txt": { link: w.path("up.txt") },
        "linked-dir": { link: w.path("sub") },
      });
      w.write(join(w.paths.agents, parent), { "note.txt": "state note\n" });
      w.write(w.paths.files, { "loose.txt": "loose\n" });

      const cases = {
        "ordinary file": w.path("up.txt"),
        image: w.path("pixel.png"),
        "file of a child": childFile.body.file.path,
        "file of another agent": strangerFile.body.file.path,
        "task attachment":
          storedTaskFile && join(w.paths.state, storedTaskFile),
        "hard link": w.path("hard.txt"),
        "21 MiB": w.path("big.txt"),
        "20 MiB": w.path("at-limit.txt"),
        symlink: w.path("link.txt"),
        "symlinked directory": w.path("linked-dir/inner.txt"),
        "dot-dot in the path": `${w.path("sub")}/../up.txt`,
        "backslash in the name": w.path("back\\slash.txt"),
        "line break in the name": w.path("line\nbreak.txt"),
        "unicode name": w.path("über notes.txt"),
        "/tmp alias": w.path("up.txt").replace(/^\/private\/tmp\//, "/tmp/"),
        "under the agent state root": join(w.paths.agents, parent, "note.txt"),
        "loose in the files root": join(w.paths.files, "loose.txt"),
        "relative path": "work/up.txt",
        missing: w.path("missing.txt"),
        directory: w.path("sub"),
      };
      for (const [label, path] of Object.entries(cases))
        w.record(
          `post: ${label}`,
          path ? await postFile(w, parent, path) : "no such file to post"
        );
    },
  },
  {
    name: "audit-2-symlinks-repo-tools",
    title: "A symlinked tools manifest still gives repo tools and the hook",
    async run(w) {
      const marker = join(w.root, "hook-ran");
      w.write(w.paths.work, {
        "shared/tools.json": toolsFile(
          [{ name: "echo", description: "Echo", command: ["echo", "ok"] }],
          { stop: { command: [w.path("shared/hook.sh")] } }
        ),
        "shared/hook.sh": markerScript(marker),
      });
      const repos = {
        "file outside the repo": await w.repo("file-out", {
          ".dispatch/tools.json": { link: w.path("shared/tools.json") },
        }),
        "file inside the repo": await w.repo("file-in", {
          "config/tools.json": echoTool,
          ".dispatch/tools.json": { link: "../config/tools.json" },
        }),
        directory: await w.repo("dir", {
          "config/tools.json": echoTool,
          ".dispatch": { link: "config" },
        }),
        "plain file (control)": await w.repo("plain", {
          ".dispatch/tools.json": echoTool,
        }),
        "broken link": await w.repo("broken", {
          ".dispatch/tools.json": { link: "gone.json" },
        }),
      };
      for (const [label, cwd] of Object.entries(repos)) {
        const id = await w.agent({ cwd });
        w.record(`${label}: tools`, await toolNames(w, id));
        w.record(`${label}: call`, await w.call(id, "repo_echo"));
        if (label !== "file outside the repo") continue;
        w.record(`${label}: stop`, await stop(w, id));
        w.record(`${label}: hook ran`, existsSync(marker));
      }
    },
  },
  {
    name: "audit-2-symlinks-personas-owners",
    title: "Symlinked persona and owner files are still read",
    async run(w) {
      w.write(w.paths.work, {
        "shared/keeper.md": persona("Keeper"),
        "shared/personas/keeper.md": persona("Keeper"),
        "shared/owners.json": owners(),
      });
      const repos = {
        "persona file": await reviewableRepo(w, "persona-file", {
          ".agents/personas/keeper.md": { link: "../../../shared/keeper.md" },
          ".agents/owners.json": owners(),
        }),
        "persona directory": await reviewableRepo(w, "persona-dir", {
          ".agents/personas": { link: "../../shared/personas" },
          ".agents/owners.json": owners(),
        }),
        "owners file": await reviewableRepo(w, "owners-file", {
          ".agents/personas/keeper.md": persona("Keeper"),
          ".agents/owners.json": { link: "../../shared/owners.json" },
        }),
      };
      for (const [label, cwd] of Object.entries(repos)) {
        const id = await w.agent({ cwd });
        w.record(`${label}: personas`, await w.call(id, "list_personas"));
        w.record(`${label}: route`, await personaRoute(w, cwd));
        w.record(
          `${label}: owner plan`,
          await w.call(id, "launch_owner_reviews", {
            context: "parity",
            dryRun: true,
            personas: ["keeper"],
          })
        );
        w.record(
          `${label}: persona launch`,
          await w.call(id, "launch_agent", {
            name: "keeper",
            persona: "keeper",
            prompt: "Look at the change.",
          })
        );
        await w.quiet();
      }
    },
  },
  {
    name: "audit-3-tool-timeout",
    title: "A tool holding stdout open past five minutes is not killed",
    // Five real minutes: the limit has no setting, and none is added for tests.
    waits: true,
    async run(w) {
      const marker = join(w.root, "background-finished");
      w.write(w.paths.work, {
        "serve.sh": {
          run: `#!/bin/sh\n(sleep 303; echo done > "${marker}") &\necho started\n`,
        },
      });
      const cwd = await w.repo("repo", {
        ".dispatch/tools.json": toolsFile([
          {
            name: "serve",
            description: "Start a server",
            command: [w.path("serve.sh")],
          },
        ]),
      });
      const id = await w.agent({ cwd });
      w.record(
        "call",
        await w.call(id, "repo_serve", {}, { timeout: 330_000 })
      );
      await sleep(5000);
      w.record("background child survived", existsSync(marker));
    },
  },
  {
    name: "audit-3-tool-cancel",
    title: "A tool runs to the end when its caller disconnects",
    async run(w) {
      const marker = join(w.root, "finished");
      w.write(w.paths.work, {
        "slow.sh": { run: `#!/bin/sh\nsleep 3\necho done > "${marker}"\n` },
      });
      const cwd = await w.repo("repo", {
        ".dispatch/tools.json": toolsFile([
          { name: "slow", description: "Slow", command: [w.path("slow.sh")] },
        ]),
      });
      const id = await w.agent({ cwd });
      await w.call(id, "repo_slow", {}, { abortAfterMs: 1200 });
      await sleep(4500);
      w.record("finished after disconnect", existsSync(marker));
    },
  },
  {
    name: "audit-3-tool-limits",
    title: "Repo tools keep main's output, argument, exit and cwd behaviour",
    async run(w) {
      w.write(w.paths.work, {
        "lots.sh": {
          run: "#!/bin/sh\nhead -c 102400 /dev/zero | tr '\\000' x\n",
        },
        "lots-err.sh": {
          run: "#!/bin/sh\nhead -c 102400 /dev/zero | tr '\\000' e >&2\n",
        },
        "split.sh": {
          run: "#!/bin/sh\nprintf 'a'\ni=0; while [ $i -lt 30000 ]; do printf 'é'; i=$((i+1)); done\n",
        },
        "signal.sh": { run: "#!/bin/sh\necho before\nkill -TERM $$\n" },
        "fail.sh": { run: "#!/bin/sh\necho out\necho bad >&2\nexit 3\n" },
        "env.sh": {
          run: '#!/bin/sh\necho "agent=$DISPATCH_AGENT_ID home=$HOME path=$PATH"\npwd\ncat\n',
        },
      });
      const tool = (name, command, params) => ({
        name,
        description: name,
        command,
        ...(params && { params }),
      });
      const cwd = await w.repo("repo", {
        "nested/file.txt": "nested\n",
        ".dispatch/tools.json": toolsFile([
          tool("lots", [w.path("lots.sh")]),
          tool("lots_err", [w.path("lots-err.sh")]),
          tool("split", [w.path("split.sh")]),
          tool("signal", [w.path("signal.sh")]),
          tool("fail", [w.path("fail.sh")]),
          tool("env", [w.path("env.sh")]),
          tool("missing", [w.path("not-there")]),
          tool("many", ["echo", ...Array.from({ length: 257 }, () => "x")]),
          tool("long", ["echo", "y".repeat(17 * KiB)]),
          tool(
            "param",
            ["echo"],
            [
              {
                name: "value",
                type: "string",
                flag: "--value",
                description: "Value",
              },
            ]
          ),
        ]),
      });
      const id = await w.agent({ cwd: join(cwd, "nested") });
      w.record("tools", await toolNames(w, id));
      for (const name of [
        "lots",
        "lots_err",
        "split",
        "signal",
        "fail",
        "env",
        "missing",
        "many",
        "long",
      ])
        w.record(name, await w.call(id, `repo_${name}`));
      w.record(
        "17 KiB parameter",
        await w.call(id, "repo_param", { value: "v".repeat(17 * KiB) })
      );
    },
  },
  {
    name: "audit-3-manifest-size",
    title: "A tools manifest over 256 KiB still loads",
    async run(w) {
      const marker = join(w.root, "hook-ran");
      w.write(w.paths.work, { "hook.sh": markerScript(marker) });
      const cwd = await w.repo("repo", {
        ".dispatch/tools.json": toolsFile(
          [
            {
              name: "echo",
              description: "d".repeat(257 * KiB),
              command: ["echo", "ok"],
            },
          ],
          { stop: { command: [w.path("hook.sh")] } }
        ),
      });
      const id = await w.agent({ cwd });
      w.record("tools", await toolNames(w, id));
      w.record("call", await w.call(id, "repo_echo"));
      w.record("stop", await stop(w, id));
      w.record("hook ran", existsSync(marker));
    },
  },
  {
    name: "audit-4-learned-models",
    title: "Model lists learned by main survive",
    async run(w) {
      const learned = {
        models: [
          { id: "parity-large", label: "Parity Large" },
          { id: "parity-small", label: "Parity Small" },
        ],
        defaultModel: "parity-large",
        seenAt: "2026-01-02T03:04:05.000Z",
      };
      await w.sql(
        "INSERT INTO settings (key, value) VALUES ('agent_models:claude', $1)",
        [JSON.stringify(learned)]
      );
      await w.restart();
      w.record("catalog", await w.api("GET", "/api/v1/agent-models"));
      await w.agent({ cwd: await w.repo("repo"), type: "codex" });
      w.record(
        "keys written",
        await w.sql(
          "SELECT key FROM settings WHERE key LIKE 'agent_models:%' ORDER BY key"
        )
      );
    },
  },
  {
    name: "audit-5-roots",
    title: "A slow or odd checkout keeps the roots main still resolves",
    async run(w) {
      const marker = join(w.root, "slow-toplevel");
      // A git that is slow at one probe while the marker holds a duration.
      w.write(w.paths.bin, {
        git: {
          run: `#!/bin/sh\nif [ -f "${marker}" ]; then case " $* " in *" --show-toplevel "*) sleep "$(cat "${marker}")";; esac; fi\nexec "${w.tools.realGit}" "$@"\n`,
        },
      });
      const cwd = await w.repo("repo", {
        ".agents/personas/keeper.md": persona("Keeper"),
        ".dispatch/tools.json": echoTool,
      });
      const bare = w.path("bare.git");
      await w.git(w.paths.work, ["clone", "--quiet", "--bare", cwd, bare]);
      const id = await w.agent({ cwd });
      const bareAgent = await w.agent({ cwd: bare });

      for (const seconds of ["6", "2"]) {
        w.write(w.root, { "slow-toplevel": seconds });
        w.record(`git ${seconds}s: tools`, await toolNames(w, id));
        w.record(
          `git ${seconds}s: brain`,
          await w.call(id, "brain_list_objects")
        );
        rmSync(marker);
      }
      w.record("bare repository: tools", await toolNames(w, bareAgent));
      w.record(
        "bare repository: brain",
        await w.call(bareAgent, "brain_list_objects")
      );
      w.record("fast (control): tools", await toolNames(w, id));
    },
  },
  {
    name: "audit-6-non-git-folder",
    title: "A folder outside Git has no checkout root",
    async run(w) {
      const marker = join(w.root, "hook-ran");
      w.write(w.paths.work, { "hook.sh": markerScript(marker) });
      const cwd = w.path("folder");
      mkdirSync(cwd);
      w.write(cwd, {
        ".dispatch/tools.json": toolsFile(
          [{ name: "echo", description: "Echo", command: ["echo", "ok"] }],
          { stop: { command: [w.path("hook.sh")] } }
        ),
        ".agents/personas/keeper.md": persona("Keeper"),
      });
      const id = await w.agent({ cwd });
      w.record("agent", await w.api("GET", agentPath(id)));
      w.record("tools", await toolNames(w, id));
      w.record("repo tool", await w.call(id, "repo_echo"));
      w.record(
        "persona upsert",
        await w.call(id, "persona_upsert", {
          slug: "written",
          name: "Written",
          description: "Written by the tool",
          instructions: "Check the folder.",
        })
      );
      w.record("personas", await w.call(id, "list_personas"));
      w.record("stop", await stop(w, id));
      w.record("hook ran", existsSync(marker));
      w.record("folder", w.tree(cwd));
    },
  },
  {
    name: "audit-7-read-caps",
    title: "Owner, persona and hook reads over 256 KiB, and big directories",
    async run(w) {
      const huge = "x".repeat(257 * KiB);
      const bigOwners = await reviewableRepo(w, "big-owners", {
        ".agents/personas/keeper.md": persona("Keeper"),
        ".agents/owners.json": `${owners()}${" ".repeat(257 * KiB)}`,
      });
      const bigPersona = await reviewableRepo(w, "big-persona", {
        ".agents/personas/keeper.md": persona("Keeper", huge),
        ".agents/owners.json": owners(),
      });
      const entries = {};
      for (let index = 0; index < 1030; index++)
        entries[`.agents/personas/note-${index}.txt`] = "note\n";
      const bigDirectory = await w.repo("big-directory", {
        ...entries,
        ".agents/personas/keeper.md": persona("Keeper"),
      });

      const ownersAgent = await w.agent({ cwd: bigOwners });
      w.record("owners file", await ownerPlan(w, ownersAgent));
      const personaAgent = await w.agent({ cwd: bigPersona });
      w.record("persona list", await w.call(personaAgent, "list_personas"));
      w.record(
        "persona in owner plan",
        await w.call(personaAgent, "launch_owner_reviews", {
          context: "parity",
          dryRun: true,
          personas: ["keeper"],
        })
      );
      const directoryAgent = await w.agent({ cwd: bigDirectory });
      w.record(
        "1031 directory entries",
        await w.call(directoryAgent, "list_personas")
      );

      const marker = join(w.root, "hook-ran");
      w.write(w.paths.work, { "hook.sh": markerScript(marker) });
      const bigHook = await w.repo("big-hook", {
        ".dispatch/tools.json": hookManifest(
          [w.path("hook.sh")],
          "h".repeat(257 * KiB)
        ),
      });
      const hookAgent = await w.agent({ cwd: bigHook });
      w.record("stop", await stop(w, hookAgent));
      w.record("hook ran", existsSync(marker));
    },
  },
  {
    name: "audit-7-persona-catalog-caps",
    title: "More than 100 personas, or more than 4 MiB of them",
    async run(w) {
      const many = {};
      for (let index = 0; index < 105; index++) {
        const slug = `p${String(index).padStart(3, "0")}`;
        many[`.agents/personas/${slug}.md`] = persona(slug);
      }
      const large = {};
      for (let index = 0; index < 18; index++) {
        const slug = `large${String(index).padStart(2, "0")}`;
        large[`.agents/personas/${slug}.md`] = persona(
          slug,
          "y".repeat(250 * KiB)
        );
      }
      const repos = {
        "105 personas": await w.repo("many", many),
        "4.4 MiB of personas": await w.repo("large", large),
      };
      for (const [label, cwd] of Object.entries(repos)) {
        const id = await w.agent({ cwd });
        w.record(`${label}: tool`, await w.call(id, "list_personas"));
        w.record(`${label}: route`, await personaRoute(w, cwd));
      }
    },
  },
  {
    name: "audit-7-changes-reply-cap",
    title: "Owner reviews of a change over 4 MiB of paths",
    async run(w) {
      const repo = await reviewableRepo(w, "repo", {
        ".agents/personas/keeper.md": persona("Keeper"),
        ".agents/owners.json": owners(),
      });
      // 5,000 committed files with 900-character paths.
      const directory = ["a", "b", "c", "d"]
        .map((letter) => letter.repeat(200))
        .join("/");
      const files = {};
      for (let index = 0; index < 5000; index++)
        files[`${directory}/${String(index).padStart(96, "0")}`] = "";
      w.write(repo, files);
      await w.git(repo, ["add", "--all"]);
      await w.git(repo, ["commit", "--quiet", "-m", "Many files"]);
      w.record("plan", await ownerPlan(w, await w.agent({ cwd: repo })));
    },
  },
];
