import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { GitHubRunnerExecutor } from "../src/agents/remote/github-runner-executor.js";
import { runnerGitArgs } from "../src/agents/remote/runner.js";

async function fixture(
  run: (input: {
    executor: GitHubRunnerExecutor;
    root: string;
    gh: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-gh-fixture-"));
  const gh = path.join(root, "gh");
  const env = { HOME: root, PATH: process.env.PATH };
  try {
    await writeFile(
      gh,
      String.raw`#!/bin/sh
set -eu
cd "$HOME"
case "$1 $2" in
  'config get')
    test "$*" = 'config get user --host github.com'
    if [ -f login ]; then cat login; else
      printf 'could not find key "user"\n' >&2
      exit 1
    fi
    ;;
  'auth login')
    test "$GH_PROMPT_DISABLED" = '1'
    test "$*" = 'auth login --hostname github.com --git-protocol https --web --insecure-storage'
    printf '! First copy your one-time code: ABCD-' >&2
    printf '1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n' >&2
    until [ -f authorize ] || [ -f reject ]; do sleep .02; done
    if [ -f reject ]; then printf 'synthetic-secret\n' >&2; exit 1; fi
    printf 'fixture-user\n' > login
    ;;
  'auth setup-git')
    test "$*" = 'auth setup-git --hostname github.com'
    git config --global credential.https://github.com.helper "!$0 auth git-credential"
    ;;
  'auth logout')
    test "$*" = 'auth logout --hostname github.com --user fixture-user'
    rm -f login
    ;;
  'auth git-credential')
    cat >/dev/null
    test "$3" = 'get'
    test -f login
    printf 'username=fixture-user\npassword=synthetic-token\n'
    ;;
  'api --hostname')
    test "$3" = 'github.com'
    case "$4" in
      user) if [ -f revoked ]; then printf '(HTTP 401)\n' >&2; exit 1; fi; cat login ;;
      repos/org/project/pulls/42) printf '%s' '{"url":"https://github.com/fork/project.git","branch":"fix"}' ;;
      *) exit 1 ;;
    esac
    ;;
  'search repos')
    test "$GH_HOST" = 'github.com'
    test -f login
    printf '%s' '[{"fullName":"org/project","url":"https://github.com/org/project"},{"fullName":"ignored/secret","url":"https://synthetic-token@github.com/org/project"}]'
    ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 }
    );
    const executor = new GitHubRunnerExecutor(env, (bin, args) => {
      expect(bin).toBe("/usr/bin/gh");
      return { bin: gh, args };
    });
    await run({ executor, root, gh, env });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("completes a device login and configures the same credential helper for an agent and managed checkout", async () => {
  await fixture(async ({ executor, root, env, gh }) => {
    const connection = new AbortController();
    const handle = (type: "status" | "login" | "logout") =>
      executor.handle({ type }, connection.signal);
    try {
      expect(await handle("status")).toEqual({ status: "signed-out" });
      expect(await handle("login")).toMatchObject({ status: "pending" });
      await vi.waitFor(async () =>
        expect(await handle("status")).toEqual({
          status: "pending",
          code: "ABCD-1234",
          verificationUrl: "https://github.com/login/device",
        })
      );
      expect(await handle("login")).toMatchObject({
        status: "pending",
        code: "ABCD-1234",
      });
      await writeFile(path.join(root, "authorize"), "");
      await vi.waitFor(async () =>
        expect(await handle("status")).toEqual({
          status: "signed-in",
          login: "fixture-user",
        })
      );
      for (const args of [
        [],
        runnerGitArgs.map((arg) => arg.replace("/usr/bin/gh", gh)),
      ]) {
        const result = execFileSync("git", [...args, "credential", "fill"], {
          cwd: root,
          env: { ...env, GIT_TERMINAL_PROMPT: "0" },
          input: "protocol=https\nhost=github.com\n\n",
          encoding: "utf8",
        });
        expect(result).toContain("username=fixture-user");
      }
      expect(
        await executor.handle(
          { type: "repositorySearch", query: "org/project" },
          connection.signal
        )
      ).toEqual({
        repositories: [
          { name: "org/project", url: "https://github.com/org/project" },
        ],
      });
      expect(
        await executor.handle(
          {
            type: "pullRequestHead",
            owner: "org",
            repo: "project",
            number: 42,
          },
          connection.signal
        )
      ).toEqual({ url: "https://github.com/fork/project.git", branch: "fix" });
      await writeFile(path.join(root, "revoked"), "");
      expect(await handle("status")).toEqual({ status: "signed-out" });
      expect(await handle("logout")).toEqual({ status: "signed-out" });
    } finally {
      connection.abort();
    }
  });
});

it("clears pending device codes on cancel, disconnect and failed authorization", async () => {
  await fixture(async ({ executor, root }) => {
    let controller = new AbortController();
    const handle = (type: "status" | "login" | "cancel") =>
      executor.handle({ type }, controller.signal);
    const pending = async () => {
      await handle("login");
      await vi.waitFor(async () =>
        expect(await handle("status")).toMatchObject({
          status: "pending",
          code: "ABCD-1234",
        })
      );
    };
    try {
      await pending();
      expect(await handle("cancel")).toEqual({ status: "signed-out" });
      await pending();
      controller.abort();
      controller = new AbortController();
      await vi.waitFor(async () =>
        expect(await handle("status")).toEqual({ status: "signed-out" })
      );
      await pending();
      await writeFile(path.join(root, "reject"), "");
      await vi.waitFor(async () =>
        expect(await handle("status")).toEqual({ status: "failed" })
      );
    } finally {
      controller.abort();
    }
  });
});
