// Worktrees, Changes, Files, reviews and the other checkout readers.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentPath,
  agentRow,
  archive,
  KiB,
  markerScript,
  MiB,
  ownerPlan,
  owners,
  persona,
  personaRoute,
  PNG,
  prompt,
  reviewableRepo,
  startAgain,
  stop,
  toolNames,
  toolsFile,
} from "./support.mjs";

const worktreeOf = async (w, id) =>
  (await agentRow(w, id))?.worktree_path ?? null;

// Pending cleanup is retried by the 30-second reconciliation.
const pastReconciliation = () => sleep(36_000);

async function commitAll(w, cwd, message) {
  await w.git(cwd, ["add", "--all"]);
  await w.git(cwd, ["commit", "--quiet", "-m", message]);
}

export const checkouts = [
  {
    name: "worktree-create",
    title: "Worktree launches: names, bases, copied files, resume",
    async run(w) {
      const repo = await w.repo(
        "repo",
        { ".gitignore": ".env\n", "sub/file.txt": "sub\n" },
        { origin: true }
      );
      await w.git(repo, ["branch", "existing"]);
      await w.git(repo, ["branch", "other-base"]);
      await w.git(repo, [
        "push",
        "--quiet",
        "origin",
        "other-base",
        "existing",
      ]);
      w.write(repo, { ".env": "FIXTURE=1\n" });
      const cases = {
        "default branch name": {},
        named: { worktreeBranch: "named" },
        based: { worktreeBranch: "based", baseBranch: "other-base" },
        "existing branch": { baseBranch: "existing", createNewBranch: false },
        "branch already used": { worktreeBranch: "named" },
      };
      let first;
      for (const [label, body] of Object.entries(cases)) {
        const { id, response } = await w.createAgent({
          cwd: repo,
          useWorktree: true,
          ...body,
        });
        w.record(label, response);
        if (!id) continue;
        first ??= id;
        const row = await agentRow(w, id);
        w.record(`${label}: row`, row);
        w.record(`${label}: agent`, await w.api("GET", agentPath(id)));
        w.record(
          `${label}: worktree status`,
          await w.api("GET", agentPath(id, "/worktree-status"))
        );
        if (row.worktree_path && existsSync(row.worktree_path))
          w.record(`${label}: files`, w.tree(row.worktree_path));
      }
      w.record("git", await w.gitState(repo));

      await stop(w, first);
      w.record("start again", await startAgain(w, first));
      await stop(w, first);
      const directory = await worktreeOf(w, first);
      if (directory) rmSync(directory, { recursive: true, force: true });
      w.record("start with its worktree gone", await startAgain(w, first));
      w.record("row with its worktree gone", await agentRow(w, first));
    },
  },
  {
    name: "worktree-location-nested",
    title: "The nested worktree location setting",
    async run(w) {
      w.record(
        "setting",
        await w.api("POST", "/api/v1/agents/settings", {
          worktreeLocation: "nested",
        })
      );
      const repo = await w.repo("repo");
      const { id, response } = await w.createAgent({
        cwd: repo,
        useWorktree: true,
        worktreeBranch: "beside",
      });
      w.record("create", response);
      if (id) w.record("row", await agentRow(w, id));
      w.record("git", await w.gitState(repo));
    },
  },
  {
    name: "worktree-archive",
    title: "Archive cleanup, for each state a worktree can be in",
    async run(w) {
      const repo = await w.repo("repo", {}, { origin: true });
      await w.git(repo, ["branch", "keep-me"]);
      await w.git(repo, ["branch", "release"]);
      const release = w.path("release");
      await w.git(repo, ["worktree", "add", "--quiet", release, "release"]);
      w.write(release, { "release.txt": "release\n" });
      await commitAll(w, release, "Release");
      await w.git(release, ["push", "--quiet", "origin", "release"]);
      await w.git(repo, ["branch", "keep-unmerged", "release"]);
      const cases = {
        clean: {},
        dirty: { files: { "dirty.txt": "dirty\n" } },
        "dirty forced": { files: { "dirty.txt": "dirty\n" }, mode: "force" },
        kept: { mode: "keep" },
        unmerged: { files: { "done.txt": "done\n" }, commit: true },
        "unmerged forced": {
          files: { "done.txt": "done\n" },
          commit: true,
          mode: "force",
        },
        "switched branch": { switchTo: "switched-to" },
        "status fails": { corruptIndex: true },
        "net-empty history": { netEmpty: true },
        "force after a stale status": { stale: true, mode: "force" },
        "switched to an existing branch": {
          existing: "keep-me",
          mode: "force",
        },
        "switched away from the recorded base": {
          baseBranch: "release",
          existing: "keep-unmerged",
        },
        "worktree gone": { gone: true },
        "nested repository forced": { nested: true, mode: "force" },
        "untracked 17 MiB forced": {
          files: { "big.bin": Buffer.alloc(17 * MiB, 1) },
          mode: "force",
        },
        "broken symlink forced": {
          files: { dangling: { link: "nowhere" } },
          mode: "force",
        },
      };
      let index = 0;
      const trees = {};
      for (const [label, setup] of Object.entries(cases)) {
        const id = await w.agent({
          cwd: repo,
          useWorktree: true,
          worktreeBranch: `case-${index++}`,
          baseBranch: setup.baseBranch,
        });
        const tree = await worktreeOf(w, id);
        if (setup.files) w.write(tree, setup.files);
        if (setup.commit) await commitAll(w, tree, label);
        if (setup.switchTo)
          await w.git(tree, ["switch", "--quiet", "-c", setup.switchTo]);
        if (
          setup.baseBranch &&
          (await agentRow(w, id))?.base_branch !== setup.baseBranch
        )
          throw new Error("The fixture did not record its comparison base");
        if (setup.existing) {
          await w.git(tree, ["switch", "--quiet", setup.existing]);
          if (setup.mode === "force") {
            w.write(tree, { "k.txt": "keep\n" });
            await commitAll(w, tree, label);
          }
        }
        if (setup.netEmpty) {
          w.write(tree, { "x.txt": "temporary\n" });
          await commitAll(w, tree, "Introduce x.txt");
          await w.git(tree, ["rm", "x.txt"]);
          await commitAll(w, tree, "Remove x.txt");
        }
        if (setup.corruptIndex) {
          const index = await w.git(tree, ["rev-parse", "--git-path", "index"]);
          writeFileSync(resolve(tree, index.trim()), Buffer.alloc(16, 7));
        }
        if (setup.nested) {
          w.write(tree, { "nested/file.txt": "nested\n" });
          await w.git(join(tree, "nested"), ["init", "--quiet"]);
        }
        if (setup.gone) rmSync(tree, { recursive: true, force: true });
        const status = await w.api("GET", agentPath(id, "/worktree-status"));
        w.record(`${label}: status`, status);
        if (setup.stale) w.write(tree, { "late.txt": "late\n" });
        const token = status.body?.checkoutState ?? "1".repeat(64);
        w.record(
          `${label}: archive`,
          await archive(
            w,
            id,
            setup.mode,
            setup.stale ? `&checkoutState=${token}` : ""
          )
        );
        trees[label] = tree;
      }
      await pastReconciliation();
      for (const [label, tree] of Object.entries(trees))
        w.record(`${label}: directory remains`, existsSync(tree));
      w.record("git", await w.gitState(repo));
    },
  },
  {
    name: "worktree-archive-no-remote",
    title: "Archive in a repository without a remote or a main branch",
    async run(w) {
      const local = await w.repo("local");
      const trunk = await w.repo("trunk");
      await w.git(trunk, ["branch", "-m", "main", "trunk"]);
      for (const [label, cwd] of [
        ["no remote", local],
        ["no main", trunk],
      ])
        for (const dirty of [false, true]) {
          const name = `${label}${dirty ? " dirty" : ""}`;
          const { id, response } = await w.createAgent({
            cwd,
            useWorktree: true,
            worktreeBranch: name.replaceAll(" ", "-"),
          });
          w.record(`${name}: create`, response);
          if (!id) continue;
          const tree = await worktreeOf(w, id);
          if (!tree) {
            w.record(`${name}: row`, await agentRow(w, id));
            continue;
          }
          if (dirty) w.write(tree, { "dirty.txt": "dirty\n" });
          w.record(
            `${name}: status`,
            await w.api("GET", agentPath(id, "/worktree-status"))
          );
          w.record(`${name}: archive`, await archive(w, id));
          w.record(`${name}: directory remains`, existsSync(tree));
        }
      const baseGone = {};
      for (const branch of ["base-gone-clean", "base-gone-committed"]) {
        const id = await w.agent({
          cwd: local,
          useWorktree: true,
          worktreeBranch: branch,
        });
        baseGone[branch] = { id, tree: await worktreeOf(w, id) };
      }
      const committed = baseGone["base-gone-committed"].tree;
      w.write(committed, { "x.txt": "committed\n" });
      await commitAll(w, committed, "Commit the work");
      await w.git(local, ["branch", "-m", "main", "trunk"]);
      for (const [name, { id, tree }] of Object.entries(baseGone)) {
        w.record(
          `${name}: status`,
          await w.api("GET", agentPath(id, "/worktree-status"))
        );
        w.record(`${name}: archive`, await archive(w, id));
        w.record(`${name}: directory remains`, existsSync(tree));
      }
      w.record("base gone: git", await w.gitState(local));
    },
  },
  {
    name: "worktree-archive-shared",
    title: "Archive of a worktree another agent works in",
    async run(w) {
      const repo = await w.repo("repo", {}, { origin: true });
      const owner = await w.agent({
        cwd: repo,
        useWorktree: true,
        worktreeBranch: "shared",
      });
      const tree = await worktreeOf(w, owner);
      const borrower = await w.agent({ cwd: tree });
      w.record(
        "status",
        await w.api("GET", agentPath(owner, "/worktree-status"))
      );
      w.record("owner archive", await archive(w, owner));
      w.record("remains for the borrower", existsSync(tree));
      w.record("borrower", await agentRow(w, borrower));
      w.record("borrower archive", await archive(w, borrower));
      await pastReconciliation();
      w.record("remains afterwards", existsSync(tree));
      w.record("git", await w.gitState(repo));
    },
  },
  {
    name: "worktree-archive-co-owner",
    title: "Archive leaves a reviewer's or selected workspace checkout on disk",
    async run(w) {
      const repo = await w.repo(
        "repo",
        { ".agents/personas/keeper.md": persona("Keeper") },
        { origin: true }
      );
      const trees = [];
      for (const kind of ["reviewer", "workspace"]) {
        const owner = await w.agent({
          cwd: repo,
          useWorktree: true,
          worktreeBranch: kind,
        });
        const tree = await worktreeOf(w, owner);
        let coOwner;
        if (kind === "reviewer") {
          const launcher = await w.agent({ cwd: tree });
          await personaRoute(w, tree);
          const result = await w.call(launcher, "launch_agent", {
            name: "keeper",
            persona: "keeper",
            prompt: "Review.",
          });
          coOwner = result.structuredContent?.agentId;
          if (!coOwner)
            throw new Error(
              `Reviewer did not launch: ${JSON.stringify(result)}`
            );
          await w.poll(async () => {
            const [row] = await w.sql(
              "SELECT role, cwd, status FROM agents WHERE id = $1",
              [coOwner]
            );
            return (
              row?.role === "review" &&
              row.cwd === tree &&
              row.status === "running"
            );
          }, "reviewer launch");
        } else {
          coOwner = await w.agent({ cwd: repo });
          w.record(
            "set workspace",
            await w.call(coOwner, "set_workspace", { path: tree })
          );
          if ((await agentRow(w, coOwner))?.workspace_path !== tree)
            throw new Error(
              "The fixture did not select the worktree as its workspace"
            );
        }
        w.record(
          `${kind}: owner archive`,
          await archive(w, owner, kind === "reviewer" ? "auto" : "force")
        );
        w.record(`${kind}: directory still in use`, existsSync(tree));
        w.record(`${kind}: co-owner archive`, await archive(w, coOwner));
        trees.push([kind, tree]);
      }
      await pastReconciliation();
      for (const [kind, tree] of trees)
        w.record(`${kind}: directory remains afterwards`, existsSync(tree));
      w.record("git", await w.gitState(repo));
    },
  },
  {
    name: "changes",
    title: "Changes: stats, diff, file diff, images, comments",
    async run(w) {
      const repo = await w.repo(
        "repo",
        {
          "kept.txt": "one\ntwo\n",
          "image.png": PNG,
          "gone.txt": "gone\n",
          "spaced.txt": "a b\n",
        },
        { origin: true }
      );
      const id = await w.agent({
        cwd: repo,
        useWorktree: true,
        worktreeBranch: "changes",
      });
      const tree = await worktreeOf(w, id);
      w.write(tree, { "committed.txt": "committed\n" });
      await commitAll(w, tree, "Committed");
      rmSync(join(tree, "gone.txt"));
      w.write(tree, {
        "kept.txt": "one\ntwo\nthree\n",
        "spaced.txt": "a  b\n",
        "image.png": Buffer.concat([PNG, Buffer.alloc(4)]),
        "untracked.txt": "untracked\n",
        "untracked.png": PNG,
        "huge.png": Buffer.alloc(11 * MiB, 7),
        "binary.bin": Buffer.from([0, 1, 2, 3]),
        "back\\slash.txt": "backslash\n",
        "colon:name.txt": "colon\n",
        "linked.txt": { link: "kept.txt" },
        "linked-dir": { link: "." },
      });
      const base = agentPath(id);
      const reads = {
        stats: "/diff-stats",
        "committed stats": "/diff-stats?includeUncommitted=false",
        diff: "/diff",
        "diff with whitespace": "/diff?ignoreWhitespace=false",
        "committed diff": "/diff?includeUncommitted=false",
        file: "/diff/file?path=kept.txt",
        "untracked file": "/diff/file?path=untracked.txt",
        "deleted file": "/diff/file?path=gone.txt",
        "backslash file": `/diff/file?path=${encodeURIComponent("back\\slash.txt")}`,
        "colon file": `/diff/file?path=${encodeURIComponent("colon:name.txt")}`,
        "symlink file": "/diff/file?path=linked.txt",
        "file not changed": "/diff/file?path=README.md",
        "file path missing": "/diff/file",
        "file path escapes": "/diff/file?path=..%2Foutside",
        "old image": "/diff/image?path=image.png&side=old",
        "new image": "/diff/image?path=image.png&side=new",
        "untracked image": "/diff/image?path=untracked.png&side=new",
        "absent old image": "/diff/image?path=untracked.png&side=old",
        "image over 10 MiB": "/diff/image?path=huge.png&side=new",
        "not an image": "/diff/image?path=kept.txt&side=new",
      };
      for (const [label, route] of Object.entries(reads)) {
        w.record(label, await w.api("GET", `${base}${route}`));
      }
      w.record(
        "comment",
        await w.api("POST", `${base}/diff/comment`, {
          filePath: "kept.txt",
          startLine: 3,
          endLine: 3,
          comment: "Why three?",
        })
      );

      const plain = w.path("plain");
      w.write(plain, { "a.txt": "a\n" });
      const outside = await w.agent({ cwd: plain });
      const checkout = await w.agent({ cwd: repo });
      for (const [label, agent] of [
        ["outside git", outside],
        ["no worktree", checkout],
      ])
        for (const route of [
          "/diff",
          "/diff-stats?includeUncommitted=false",
          "/diff/file?path=a.txt",
          "/diff/image?path=a.png&side=new",
        ]) {
          w.record(
            `${label}: ${route}`,
            await w.api("GET", agentPath(agent, route))
          );
        }
    },
  },
  {
    name: "files-pane",
    title: "Files: directory, preview, index",
    async run(w) {
      const files = {
        "note.txt": "note\n",
        "pixel.png": PNG,
        "art.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
        "binary.bin": Buffer.from([0, 1, 2, 3]),
        "big.txt": "b".repeat(MiB + 1),
        "dir/inner.txt": "inner\n",
        "back\\slash.txt": "backslash\n",
        "colon:name.txt": "colon\n",
        ".gitignore": "ignored.txt\n",
        "link.txt": { link: "note.txt" },
        "link-dir": { link: "dir" },
      };
      for (let index = 0; index < 505; index++)
        files[`many/file-${String(index).padStart(3, "0")}`] = "x\n";
      const repo = await w.repo("repo", files);
      w.write(repo, { "ignored.txt": "ignored\n" });
      const plain = w.path("plain");
      w.write(plain, { "a.txt": "a\n", "b/c.txt": "c\n" });

      const read = async (id, cwd, query) =>
        w.api(
          "GET",
          agentPath(
            id,
            `/workspace?${new URLSearchParams({ workspace: cwd, ...query })}`
          )
        );
      const id = await w.agent({ cwd: repo });
      const preview = (path) => ({ path, file: "true" });
      const cases = {
        root: {},
        directory: { path: "dir" },
        "505 entries": { path: "many" },
        index: { index: "true" },
        text: preview("note.txt"),
        image: preview("pixel.png"),
        svg: preview("art.svg"),
        binary: preview("binary.bin"),
        "over 1 MiB": preview("big.txt"),
        backslash: preview("back\\slash.txt"),
        colon: preview("colon:name.txt"),
        ignored: preview("ignored.txt"),
        symlink: preview("link.txt"),
        "symlinked directory": { path: "link-dir" },
        "git directory": { path: ".git" },
        escape: preview("../outside"),
        absolute: preview("/etc/hosts"),
        missing: preview("absent.txt"),
        "directory as a file": preview("dir"),
        "file as a directory": { path: "note.txt" },
        "long path": preview(`${"p/".repeat(600)}x`),
      };
      for (const [label, query] of Object.entries(cases))
        w.record(label, await read(id, repo, query));
      w.record("another workspace", await read(id, plain, {}));
      w.record(
        "no workspace parameter",
        await w.api("GET", agentPath(id, "/workspace"))
      );
      const outside = await w.agent({ cwd: plain });
      w.record("outside git", await read(outside, plain, {}));
      w.record(
        "outside git index",
        await read(outside, plain, { index: "true" })
      );
    },
  },
  {
    name: "set-workspace",
    serial: true,
    title: "set_workspace, and what follows it",
    async run(w) {
      const marker = join(w.root, "tool-ran");
      w.write(w.paths.work, { "tool.sh": markerScript(marker) });
      const home = await w.repo("home-repo", {
        "nested/file.txt": "nested\n",
      });
      const other = await w.repo("other", {
        "inner/file.txt": "inner\n",
        ".dispatch/tools.json": toolsFile([
          { name: "here", description: "Here", command: [w.path("tool.sh")] },
        ]),
      });
      const side = w.path("side");
      await w.git(home, ["worktree", "add", "--quiet", "-b", "side", side]);
      const plain = w.path("plain");
      w.write(plain, { "a.txt": "a\n" });
      w.write(w.paths.work, { "other-link": { link: other } });

      const id = await w.agent({ cwd: home });
      const cases = {
        subdirectory: { path: join(home, "nested") },
        "own worktree": { path: side },
        "own worktree with a base": { path: side, baseBranch: "main" },
        "bad base": { path: side, baseBranch: "bad branch" },
        "another repository": { path: other },
        "another repository, inner": { path: join(other, "inner") },
        "through a symlink": { path: w.path("other-link") },
        "a file": { path: join(other, "README.md") },
        relative: { path: "work/other" },
        missing: { path: w.path("none") },
        "outside git": { path: plain },
        "back to launch": {},
      };
      for (const [label, input] of Object.entries(cases)) {
        w.record(label, await w.call(id, "set_workspace", input));
        await w.quiet();
        w.record(`${label}: agent`, await w.api("GET", agentPath(id)));
        w.record(`${label}: tools`, await toolNames(w, id));
      }
    },
  },
  {
    name: "git-context",
    serial: true,
    title: "Branch and repository follow the checkout",
    async run(w) {
      const repo = await w.repo("repo");
      const id = await w.agent({ cwd: repo });
      w.record("at launch", await w.api("GET", agentPath(id)));
      await w.git(repo, ["switch", "--quiet", "-c", "later"]);
      await prompt(w, id, "after a switch");
      await w.quiet(1500);
      w.record("after a turn", await w.api("GET", agentPath(id)));
      await w.git(repo, ["switch", "--quiet", "--detach"]);
      await prompt(w, id, "after detaching");
      await w.quiet(1500);
      w.record("detached", await w.api("GET", agentPath(id)));
    },
  },
  {
    name: "owner-reviews",
    title: "Owner review plans and launches",
    async run(w) {
      const files = {
        ".agents/personas/keeper.md": persona("Keeper"),
        ".agents/owners.json": owners(),
      };
      const repo = await reviewableRepo(w, "repo", files);
      w.write(repo, { "untracked.txt": "untracked\n" });
      const id = await w.agent({ cwd: repo });
      w.record("plan", await ownerPlan(w, id));
      w.record(
        "launch",
        await w.call(id, "launch_owner_reviews", { context: "the change" })
      );
      await w.quiet(2500);
      w.record(
        "reviewers",
        await w.sql(
          "SELECT name, cwd, persona, role, project_id, parent_agent_id, launched_by_agent_id, persona_context, base_branch FROM agents WHERE id <> $1 ORDER BY created_at",
          [id]
        )
      );

      const big = await reviewableRepo(w, "big", files);
      w.write(big, { "big.bin": Buffer.alloc(17 * MiB, 1) });
      w.record(
        "17 MiB untracked",
        await ownerPlan(w, await w.agent({ cwd: big }))
      );

      const nested = await reviewableRepo(w, "nested", files);
      w.write(nested, { "inner/file.txt": "inner\n" });
      await w.git(join(nested, "inner"), ["init", "--quiet"]);
      w.record(
        "nested repository",
        await ownerPlan(w, await w.agent({ cwd: nested }))
      );

      const odd = await reviewableRepo(w, "odd", files);
      w.write(odd, { "back\\slash.txt": "odd\n" });
      w.record(
        "backslash file",
        await ownerPlan(w, await w.agent({ cwd: odd }))
      );

      const alone = await w.repo("alone", files);
      w.write(alone, { "new.txt": "new\n" });
      w.record("no remote", await ownerPlan(w, await w.agent({ cwd: alone })));
    },
  },
  {
    name: "owner-reviews-many-files",
    title: "Owner reviews with over 10,000 dirty files",
    async run(w) {
      const repo = await reviewableRepo(w, "repo", {
        ".agents/personas/keeper.md": persona("Keeper"),
        ".agents/owners.json": owners(),
      });
      const files = {};
      for (let index = 0; index < 10_005; index++)
        files[`many/${index}.txt`] = "";
      w.write(repo, files);
      w.record("plan", await ownerPlan(w, await w.agent({ cwd: repo })));
    },
  },
  {
    name: "personas-default-branch",
    title: "Personas merged upstream appear in the catalog",
    async run(w) {
      const repo = await w.repo(
        "repo",
        { ".agents/personas/local.md": persona("Local") },
        { origin: true }
      );
      const pusher = w.path("pusher");
      await w.git(w.paths.work, [
        "clone",
        "--quiet",
        w.path("repo.git"),
        pusher,
      ]);
      w.write(pusher, {
        ".agents/personas/upstream.md": persona("Upstream"),
        ".agents/personas/oversize.md": persona(
          "Oversize",
          "z".repeat(300 * KiB)
        ),
      });
      await commitAll(w, pusher, "Upstream personas");
      await w.git(pusher, ["push", "--quiet", "origin", "main"]);

      const id = await w.agent({ cwd: repo });
      // The first read starts the background refresh. Compare the settled one.
      await personaRoute(w, repo);
      await w.call(id, "list_personas");
      w.record("route", await personaRoute(w, repo));
      w.record("tool", await w.call(id, "list_personas"));
      w.record(
        "launch upstream",
        await w.call(id, "launch_agent", {
          name: "upstream",
          persona: "upstream",
          prompt: "Review.",
        })
      );
    },
  },
];
