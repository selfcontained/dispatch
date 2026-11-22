// The rest of the product surface that this branch re-routed for local users.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentPath, persona, PNG, toolsFile } from "./support.mjs";

const query = (path, values) => `${path}?${new URLSearchParams(values)}`;

export const product = [
  {
    name: "system-probes",
    title: "Path, branch, project and settings probes",
    async run(w) {
      const repo = await w.repo("repo", { "icon.png": PNG }, { origin: true });
      await w.git(repo, ["branch", "zeta"]);
      await w.git(repo, ["push", "--quiet", "origin", "zeta"]);
      const plain = w.path("plain");
      mkdirSync(join(plain, "Alpha"), { recursive: true });
      mkdirSync(join(plain, ".hidden"));
      const bare = await w.repo("no-icon");

      const gets = {
        health: "/api/v1/health",
        branding: "/api/v1/app/branding",
        defaults: "/api/v1/system/defaults",
        models: "/api/v1/agent-models",
        "agent types": "/api/v1/app/settings/agent-types",
        "agent settings": "/api/v1/agents/settings",
        ides: "/api/v1/app/settings/ides",
        plugin: "/api/v1/plugin/status?agentType=claude",
      };
      for (const [label, path] of Object.entries(gets))
        w.record(label, await w.api("GET", path));
      for (const [label, path] of Object.entries({
        repository: repo,
        folder: plain,
        file: join(repo, "README.md"),
        missing: w.path("none"),
        relative: "work/repo",
        tilde: "~",
        "private folder": join(w.paths.home, "Documents"),
      }))
        w.record(
          `path info: ${label}`,
          await w.api("GET", query("/api/v1/system/path-info", { path }))
        );
      for (const [label, prefix] of Object.entries({
        directory: `${plain}/`,
        hidden: `${plain}/.h`,
        case: `${plain}/al`,
        tilde: "~/",
        relative: "work/",
      }))
        w.record(
          `completions: ${label}`,
          await w.api(
            "GET",
            query("/api/v1/system/path-completions", { prefix })
          )
        );
      for (const [label, cwd] of Object.entries({
        origin: repo,
        "no origin": bare,
        folder: plain,
      }))
        w.record(
          `branches: ${label}`,
          await w.api("GET", query("/api/v1/git/branches", { cwd }))
        );

      for (const [label, repoRoot] of Object.entries({
        "with icon": repo,
        "without icon": bare,
        folder: plain,
        missing: w.path("none"),
      })) {
        const project = await w.api("POST", "/api/v1/projects", {
          name: label,
          color: "#336699",
          repoRoot,
        });
        w.record(`project: ${label}`, project);
        if (project.body?.id)
          w.record(
            `project icon: ${label}`,
            await w.api("GET", `/api/v1/projects/${project.body.id}/icon`)
          );
        w.record(
          `icon preview: ${label}`,
          await w.api(
            "GET",
            query("/api/v1/projects/icon-preview", { repoRoot })
          )
        );
      }
      w.record("projects", await w.api("GET", "/api/v1/projects"));
      const id = await w.agent({ cwd: repo });
      w.record("repo icon", await w.api("GET", agentPath(id, "/repo-icon")));
    },
  },
  {
    name: "jobs-templates",
    title: "Saved jobs and templates, by HTTP and by MCP",
    async run(w) {
      const cwd = await w.repo("repo", {
        ".agents/personas/builder.md": persona("Builder", "Build.", "task"),
        ".dispatch/tools.json": toolsFile([]),
      });
      const id = await w.agent({ cwd });
      const saved = {
        name: "saved",
        directory: cwd,
        prompt: "Do the work.",
      };
      w.record("job", await w.call(id, "create_job", saved));
      w.record(
        "job in the current folder",
        await w.call(id, "create_job", { name: "here", prompt: "Here." })
      );
      w.record(
        "job with persona",
        await w.call(id, "create_job", {
          ...saved,
          name: "with-persona",
          persona: "builder",
        })
      );
      w.record(
        "job in a missing folder",
        await w.call(id, "create_job", {
          ...saved,
          name: "lost",
          directory: w.path("none"),
        })
      );
      w.record("jobs", await w.call(id, "list_jobs", { directory: cwd }));
      w.record("jobs over HTTP", await w.api("GET", "/api/v1/jobs"));
      const template = { ...saved, name: "saved-template" };
      w.record("template", await w.call(id, "create_template", template));
      w.record(
        "template with a bad persona",
        await w.call(id, "create_template", {
          ...template,
          name: "bad-persona",
          persona: "nobody",
        })
      );
      w.record(
        "templates",
        await w.call(id, "list_templates", { directory: cwd })
      );
      const listed = await w.api("GET", "/api/v1/templates");
      w.record("templates over HTTP", listed);
      const launchable = (listed.body?.templates ?? listed.body)?.[0];
      if (launchable?.id) {
        const launched = await w.api(
          "POST",
          `/api/v1/templates/${launchable.id}/launch`,
          {}
        );
        // The reply carries whatever had settled by then. The settled agent
        // is what is compared, in the list below.
        w.record(
          "launch template",
          launched.status < 300 ? launched.status : launched
        );
        await w.quiet(2000);
        w.record("agents", await w.api("GET", "/api/v1/agents"));
      }
    },
  },
  {
    name: "brain",
    title: "Brain keys are the repository's, from any of its checkouts",
    async run(w) {
      const repo = await w.repo("repo", { "nested/file.txt": "nested\n" });
      const root = await w.agent({ cwd: repo });
      const nested = await w.agent({ cwd: join(repo, "nested") });
      const tree = await w.agent({
        cwd: repo,
        useWorktree: true,
        worktreeBranch: "brain",
      });
      w.record(
        "store",
        await w.call(tree, "brain_store_object", {
          collection: "parity",
          name: "fact",
          value: { known: true },
        })
      );
      for (const [label, id] of Object.entries({ root, nested, tree }))
        w.record(
          `read from ${label}`,
          await w.call(id, "brain_get_object", {
            collection: "parity",
            name: "fact",
          })
        );
      w.record(
        "keys",
        await w.sql("SELECT repo_root FROM brain_objects ORDER BY repo_root")
      );
    },
  },
  {
    name: "human-terminal",
    title: "Open and close a terminal in a session's checkout",
    async run(w) {
      const cwd = await w.repo("repo");
      const id = await w.agent({ cwd });
      const origin = `http://127.0.0.1:${w.port}`;
      const setup = await w.request("POST", "/api/v1/auth/setup", {
        body: { password: "parity-fixture-password" },
        headers: { origin },
      });
      const cookie = setup.headers?.["set-cookie"]?.[0]?.split(";")[0];
      if (!cookie) {
        w.record("setup", setup.status);
        return;
      }
      w.secrets.add(cookie);
      const headers = { origin, cookie };
      const opened = await w.api(
        "POST",
        "/api/v1/human-terminals",
        { agentId: id, clientId: "parity-client-0000000001" },
        { headers }
      );
      const terminal = opened.body?.id ?? opened.body?.terminalId;
      w.record("open", opened);
      if (terminal)
        w.record(
          "close",
          await w.api(
            "DELETE",
            `/api/v1/human-terminals/${terminal}`,
            undefined,
            { headers }
          )
        );
    },
  },
];
