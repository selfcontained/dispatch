import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  GitHubRunnerExecutor,
  githubCredentialInclude,
} from "../src/agents/remote/github-runner-executor.js";
import { runnerGitArgs } from "../src/agents/remote/runner.js";

/** The running sign-in printed its code, or ended without one. */
async function codeShown(executor: GitHubRunnerExecutor) {
  const login = executor["login"];
  while (login && !login.code && executor["login"] === login)
    await Promise.race([once(login.child.stderr!, "data"), login.finished]);
}

async function fixture(
  run: (input: {
    executor: GitHubRunnerExecutor;
    root: string;
    gh: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>,
  privateHome = true,
  /** gh resolves to the fixture itself, as a workload login PATH would find it. */
  resolvedGh = false
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
if [ "$1" = '--version' ]; then
  cat gh-version
  exit 0
fi
case "$1 $2" in
  'config get')
    test "$*" = 'config get user --host github.com'
    if [ -f login ]; then cat login; elif [ -f legacy ]; then exit 0; else
      printf 'could not find key "user"\n' >&2
      exit 1
    fi
    ;;
  'auth status')
    if [ -f network-down ]; then
      printf 'dial tcp: network is unreachable\n' >&2
    else
      printf 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n' >&2
    fi
    exit 1
    ;;
  'config set') test "$*" = 'config set git_protocol https --host github.com' ;;
  'auth login')
    test "$GH_PROMPT_DISABLED" = '1'
    test "$*" = 'auth login --hostname github.com --web'
    printf '! First copy your one-time code: ABCD-' >&2
    printf '1234\n' >&2
    if [ ! -f legacy ]; then
      printf 'Open this URL to continue in your web browser: https://github.com/login/device\n' >&2
    fi
    until [ -f authorize ] || [ -f reject ]; do sleep .02; done
    if [ -f reject ]; then printf 'synthetic-secret\n' >&2; exit 1; fi
    printf 'fixture-user\n' > login
    ;;
  'auth token')
    test "$*" = 'auth token --hostname github.com'
    cat active-token
    ;;
  'auth setup-git')
    test "$*" = 'auth setup-git --hostname github.com'
    git config --global credential.https://github.com.helper "!$0 auth git-credential"
    ;;
  'auth logout')
    if [ -f gh-version ]; then
      if [ "$#" = '6' ]; then
        printf 'unknown flag: --user\n' >&2
        exit 1
      fi
      test "$*" = 'auth logout --hostname github.com'
    else
      test "$*" = 'auth logout --hostname github.com --user fixture-user'
    fi
    if [ -f hold-logout ]; then
      touch logout-started
      until [ -f release-logout ]; do sleep .02; done
    fi
    rm -f login
    ;;
  'auth git-credential')
    cat >/dev/null
    test "$3" = 'get'
    test -f login
    printf 'username=fixture-user\npassword=synthetic-token\n'
    ;;
  'api graphql')
    test "$3 $4" = '--hostname github.com'
    test "$7 $8 $9" = '-f owner=org -f'
    case "$6" in
      *'baseRefOid headRefOid'*)
        test "$GH_TOKEN" = 'approved-token'
        cat detail-response
        ;;
      *)
        test -f login
        cat graphql-response
        exit 1
        ;;
    esac
    ;;
  'api --hostname')
    test "$3" = 'github.com'
    case "$4" in
      user/repos)
        test "$5 $6 $7 $8 $9" = "--method GET -f affiliation=owner,collaborator,organization_member -f"
        test "$GH_HOST" = 'github.com'
        test -f login
        for arg in "$@"; do
          case "$arg" in page=*) page=$(printf '%s' "$arg" | cut -d= -f2) ;; esac
        done
        if [ -f long-pagination ]; then
          if [ "$page" = 2 ] && [ -f hold-page-two ]; then
            touch page-two-started
            until [ -f release-page-two ]; do sleep .02; done
          fi
          if [ "$page" -lt 49 ]; then
            awk -v page="$page" 'BEGIN {
              printf "["
              for (i=1; i<=100; i++) {
                if (i>1) printf ","
                printf "{\"name\":\"fixture/page-%d-item-%d\",\"url\":\"https://github.com/fixture/page-%d-item-%d\"}", page,i,page,i
              }
              printf "]"
            }'
          elif [ "$page" = 49 ]; then
            printf '%s' '[{"name":"fixture/older-repo","url":"https://github.com/fixture/older-repo"}]'
          else
            printf '[]'
          fi
          exit 0
        fi
        if [ -f hold-repositories ]; then
          touch repository-search-started
          until [ -f release-repositories ]; do sleep .02; done
        fi
        printf '%s' '[{"name":"org/project","url":"https://github.com/org/project"},{"name":"unrelated/other","url":"https://github.com/unrelated/other"},{"name":"org/project-secret","url":"https://synthetic-token@github.com/org/project"}]'
        ;;
      user)
        if [ -f revoked ]; then printf '(HTTP 401)\n' >&2; exit 1; fi
        if [ -f api-down ]; then printf 'dial tcp: network is unreachable\n' >&2; exit 1; fi
        if [ -f hold-user ]; then
          touch user-started
          until [ -f release-user ]; do sleep .02; done
        fi
        test -s login
        case "$6" in
          .login) cat login ;;
          '{login,id,name}')
            if [ -f no-profile-name ]; then
              printf '{"login":"fixture-user","id":1234,"name":null}'
            else
              printf '{"login":"fixture-user","id":1234,"name":"Fixture User"}'
            fi
            ;;
          *) exit 1 ;;
        esac
        ;;
      repos/org/project/pulls/42)
        if [ "$6" = '.number' ]; then
          test "$GH_TOKEN" = 'approved-token'
          printf '42'
          exit 0
        fi
        printf '%s' '{"url":"https://github.com/fork/project.git","branch":"fix"}' ;;
      repos/org/project/compare/*)
        test "$GH_TOKEN" = 'approved-token'
        test "$4" = "$(cat compare-path)"
        printf '%s' '[{"path":"src/example.ts","additions":1,"deletions":0,"patch":"@@ -1 +1 @@"}]'
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 }
    );
    const executor = new GitHubRunnerExecutor(
      env,
      (bin, args) => {
        if (
          [
            "/usr/bin/git",
            "/bin/mkdir",
            "/bin/chmod",
            "/bin/rm",
            "/bin/rmdir",
          ].includes(bin)
        )
          return { bin, args };
        expect(bin).toBe(resolvedGh ? gh : "/usr/bin/gh");
        return { bin: gh, args };
      },
      undefined,
      resolvedGh
        ? {
            resolve: async (tool) => (tool === "gh" ? gh : "/usr/bin/git"),
            invalidate() {},
          }
        : undefined,
      privateHome
    );
    const commands = new Set<Promise<unknown>>();
    const runCommand = executor["runCommand"].bind(executor);
    executor["runCommand"] = (...args) => {
      const command = runCommand(...args);
      commands.add(command);
      const forget = () => commands.delete(command);
      command.then(forget, forget);
      return command;
    };
    try {
      await run({ executor, root, gh, env });
    } finally {
      // Sign-in and prefetched pages outlive the calls that started them.
      await executor["stopLogin"]();
      while (commands.size) await Promise.allSettled([...commands]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("offers sign-in for an empty legacy gh account and preserves network failures", async () => {
  await fixture(async ({ executor, root }) => {
    const { signal } = new AbortController();
    await writeFile(path.join(root, "legacy"), "");
    expect(await executor.handle({ type: "status" }, signal)).toEqual({
      status: "signed-out",
    });
    await writeFile(path.join(root, "network-down"), "");
    expect(await executor.handle({ type: "status" }, signal)).toEqual({
      status: "unavailable",
      message: "The runner could not connect to github.com.",
    });
  });
});

it("enters the selected checkout inside the workload wrapper for a PR head read", async () => {
  await fixture(async ({ root, gh, env }) => {
    const cwd = path.join(root, "selected checkout '$");
    await mkdir(cwd);
    await writeFile(
      gh,
      `#!/bin/sh
set -eu
pwd -P > "$HOME/selected"
printf '%s\\n' "$@" > "$HOME/arguments"
cat "$HOME/response"
`
    );
    const wrap = vi.fn((bin: string, args: string[]) => ({ bin, args }));
    const executor = new GitHubRunnerExecutor(env, wrap, undefined, {
      resolve: async () => gh,
      invalidate() {},
    });
    const operation = {
      type: "pullRequestHeadAtPath" as const,
      owner: "org",
      repo: "repo",
      number: 3,
      cwd,
    };
    const expected = {
      url: "https://github.com/fork/repo.git",
      branch: "topic",
    };
    await writeFile(path.join(root, "response"), JSON.stringify(expected));
    const signal = new AbortController().signal;
    expect(await executor.handle(operation, signal)).toEqual(expected);
    expect(wrap.mock.calls[0]?.[1]).toContain(cwd);
    expect((await readFile(path.join(root, "selected"), "utf8")).trim()).toBe(
      await realpath(cwd)
    );
    expect(
      (await readFile(path.join(root, "arguments"), "utf8")).trim().split("\n")
    ).toEqual([
      "api",
      "--hostname",
      "github.com",
      "repos/org/repo/pulls/3",
      "--jq",
      "{url:.head.repo.clone_url,branch:.head.ref}",
    ]);
    await writeFile(path.join(root, "response"), "{}");
    await expect(executor.handle(operation, signal)).rejects.toThrow(
      "GitHub pull request source branch is unavailable."
    );
  });
});

it("invalidates in-flight repository searches and prevents cache refills during logout", async () => {
  await fixture(async ({ executor, root }) => {
    const signal = new AbortController().signal;
    const flag = (name: string) => writeFile(path.join(root, name), "");
    /** The command wrote its marker, unless it ended without doing so. */
    const waitForFlag = async (name: string, command: Promise<unknown>) => {
      let ended = false;
      const end = () => (ended = true);
      command.then(end, end);
      for (;;) {
        const last = ended;
        if (
          await access(path.join(root, name)).then(
            () => true,
            () => false
          )
        )
          return;
        if (last) throw new Error(`ended before ${name}`);
        await delay(20);
      }
    };
    const search = () =>
      executor.handle(
        { type: "repositorySearch", query: "org/project" },
        signal
      );
    await writeFile(path.join(root, "login"), "fixture-user\n");
    await Promise.all([flag("hold-repositories"), flag("hold-logout")]);

    const beforeLogout = search().catch((error: unknown) => error);
    await waitForFlag("repository-search-started", beforeLogout);
    const logout = executor.handle({ type: "logout" }, signal);
    await waitForFlag("logout-started", logout);
    const duringLogout = search().catch((error: unknown) => error);
    await flag("release-repositories");
    await flag("release-logout");

    expect(await logout).toEqual({ status: "signed-out" });
    expect(await beforeLogout).toBeInstanceOf(Error);
    expect(await duringLogout).toBeInstanceOf(Error);
    await expect(search()).rejects.toThrow();
  });
});

it("returns the first twelve matches while a later repository page is pending", async () => {
  await fixture(async ({ executor, root }) => {
    const flag = (name: string) => writeFile(path.join(root, name), "");
    await writeFile(path.join(root, "login"), "fixture-user\n");
    await Promise.all([flag("long-pagination"), flag("hold-page-two")]);
    const search = executor.handle(
      { type: "repositorySearch", query: "fixture/page-1-" },
      new AbortController().signal
    );
    try {
      const result = await search;
      const pageTwo = executor["repositories"]!.pages.get(2)!;
      expect(
        await Promise.race([
          pageTwo.then(
            () => "ended",
            () => "ended"
          ),
          new Promise((resolve) => setImmediate(resolve, "pending")),
        ])
      ).toBe("pending");
      expect(result).toMatchObject({
        repositories: expect.arrayContaining([
          {
            name: "fixture/page-1-item-12",
            url: "https://github.com/fixture/page-1-item-12",
          },
        ]),
      });
    } finally {
      await flag("release-page-two");
      await search;
    }
  });
});

it("finds repositories after the prefetched page window", async () => {
  await fixture(async ({ executor, root }) => {
    await writeFile(path.join(root, "login"), "fixture-user\n");
    await writeFile(path.join(root, "long-pagination"), "");
    expect(
      await executor.handle(
        { type: "repositorySearch", query: "fixture/older-repo" },
        new AbortController().signal
      )
    ).toEqual({
      repositories: [
        {
          name: "fixture/older-repo",
          url: "https://github.com/fixture/older-repo",
        },
      ],
    });
  });
});

it("reports a missing CLI separately from a signed-out account", async () => {
  await fixture(async ({ executor, gh }) => {
    await rm(gh);
    expect(
      await executor.handle({ type: "status" }, new AbortController().signal)
    ).toMatchObject({
      status: "unavailable",
      message: "GitHub CLI is missing on this runner.",
    });
  });
});

it("keeps a verified GitHub account usable if global Git identity setup fails", async () => {
  await fixture(async ({ executor, root }) => {
    const signal = new AbortController().signal;
    await writeFile(path.join(root, "login"), "fixture-user\n");
    await mkdir(path.join(root, ".gitconfig"));
    expect(await executor.handle({ type: "status" }, signal)).toEqual({
      status: "signed-in",
      login: "fixture-user",
      gitIdentityUnavailable: true,
    });
    expect(
      await executor.handle(
        { type: "repositorySearch", query: "org/project" },
        signal
      )
    ).toEqual({
      repositories: [
        { name: "org/project", url: "https://github.com/org/project" },
      ],
    });
  });
});

it("completes a device login and gives the account's plain git the login until sign-out", async () => {
  await fixture(
    async ({ executor, root, env, gh }) => {
      const connection = new AbortController();
      const handle = (type: "status" | "login" | "logout") =>
        executor.handle({ type }, connection.signal);
      try {
        expect(await handle("status")).toEqual({ status: "signed-out" });
        expect(await handle("login")).toMatchObject({ status: "pending" });
        await codeShown(executor);
        expect(await handle("status")).toEqual({
          status: "pending",
          code: "ABCD-1234",
          verificationUrl: "https://github.com/login/device",
        });
        expect(await handle("login")).toMatchObject({
          status: "pending",
          code: "ABCD-1234",
        });
        const authorized = executor["login"]!.finished;
        await writeFile(path.join(root, "authorize"), "");
        await authorized;
        expect(await handle("status")).toEqual({
          status: "signed-in",
          login: "fixture-user",
        });
        // The global configuration names the include, never a helper or token.
        expect(
          await readFile(path.join(root, ".gitconfig"), "utf8")
        ).not.toMatch(/helper|synthetic/);
        expect(plainCredential(env, gh)).toContain(
          "password=synthetic-token\n"
        );
        const include = path.join(root, githubCredentialInclude);
        expect(gitConfig(env, "include.path")).toBe(include);
        expect(await readFile(include, "utf8")).not.toContain("synthetic");
        const args = runnerGitArgs.map((arg) => arg.replace("/usr/bin/gh", gh));
        const result = execFileSync("git", [...args, "credential", "fill"], {
          cwd: root,
          env: { ...env, GIT_TERMINAL_PROMPT: "0" },
          input: "protocol=https\nhost=github.com\n\n",
          encoding: "utf8",
        });
        expect(result).toContain("username=fixture-user");
        expect(gitConfig(env, "user.name")).toBe("Fixture User");
        expect(gitConfig(env, "user.email")).toBe(
          "1234+fixture-user@users.noreply.github.com"
        );
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
        ).toEqual({
          url: "https://github.com/fork/project.git",
          branch: "fix",
        });
        await writeFile(
          path.join(root, "graphql-response"),
          JSON.stringify({
            errors: [{ message: "private diagnostic" }],
            data: {
              repository: {
                pullRequest: {
                  state: "OPEN",
                  title: "Partial status",
                  headRefOid: "sha",
                },
              },
            },
          })
        );
        expect(
          await executor.handle(
            {
              type: "pullRequestStatus",
              owner: "org",
              repo: "project",
              number: 42,
            },
            connection.signal
          )
        ).toEqual({
          state: "OPEN",
          title: "Partial status",
          head: "sha",
          draft: false,
          rollup: null,
        });
        await writeFile(path.join(root, "revoked"), "");
        expect(await handle("status")).toEqual({ status: "signed-out" });
        expect(await handle("logout")).toEqual({ status: "signed-out" });
        expect(plainCredential(env, gh)).toBe("");
        expect(
          await readFile(path.join(root, ".gitconfig"), "utf8")
        ).not.toMatch(/include|dispatch-runner/);
        await expect(access(include)).rejects.toThrow();
      } finally {
        connection.abort();
      }
    },
    true,
    true
  );
});

/** What plain `git credential fill` gets for github.com, outside any repository. */
function plainCredential(env: NodeJS.ProcessEnv, gh: string) {
  try {
    return execFileSync("git", ["credential", "fill"], {
      cwd: "/",
      env: {
        ...env,
        PATH: `${path.dirname(gh)}:${process.env.PATH}`,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
      },
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function gitConfig(env: NodeJS.ProcessEnv, key: string, value?: string) {
  return execFileSync(
    "git",
    ["config", "--global", key, ...(value === undefined ? [] : [value])],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  ).trim();
}

it("fills missing Git identity for an existing login and preserves custom values", async () => {
  await fixture(async ({ executor, root, env }) => {
    const signal = new AbortController().signal;
    await writeFile(path.join(root, "login"), "fixture-user");
    await writeFile(path.join(root, "no-profile-name"), "");
    gitConfig(env, "user.email", "custom@example.com");
    expect(await executor.handle({ type: "status" }, signal)).toEqual({
      status: "signed-in",
      login: "fixture-user",
    });
    expect(gitConfig(env, "user.name")).toBe("fixture-user");
    expect(gitConfig(env, "user.email")).toBe("custom@example.com");
    gitConfig(env, "user.name", "Custom Name");
    await executor.handle({ type: "login" }, signal);
    expect(gitConfig(env, "user.name")).toBe("Custom Name");
    expect(gitConfig(env, "user.email")).toBe("custom@example.com");
  });
});

it("adds only the credential include to an existing user's Git configuration and removes it on sign-out", async () => {
  await fixture(async ({ executor, root, env }) => {
    const signal = new AbortController().signal;
    await writeFile(path.join(root, "login"), "fixture-user");
    gitConfig(env, "user.email", "custom@example.com");
    gitConfig(env, "credential.helper", "store");
    // What `gh auth setup-git` writes; the second line equals Dispatch's helper.
    gitConfig(env, "credential.https://github.com.helper", "");
    execFileSync(
      "git",
      [
        "config",
        "--global",
        "--add",
        "credential.https://github.com.helper",
        "!/usr/bin/gh auth git-credential",
      ],
      { env }
    );
    const include = path.join(root, githubCredentialInclude);
    // Differs only where a regular expression would match any character.
    gitConfig(env, "include.path", include.replace(".config", "Xconfig"));
    const config = path.join(root, ".gitconfig");
    const before = await readFile(config, "utf8");
    for (const type of ["status", "login", "status"] as const)
      expect(await executor.handle({ type }, signal)).toEqual({
        status: "signed-in",
        login: "fixture-user",
        gitIdentityUnavailable: true,
      });
    // Identity stays the user's; their own helper keeps running first.
    expect(await readFile(config, "utf8")).toBe(
      `${before}\tpath = ${include}\n`
    );
    // The user's lines first, then the include's: theirs keep priority.
    expect(
      execFileSync(
        "git",
        ["config", "--get-all", "credential.https://github.com.helper"],
        { env, encoding: "utf8" }
      )
    ).toBe(
      "\n!/usr/bin/gh auth git-credential\n!/usr/bin/gh auth git-credential\n"
    );
    expect((await stat(include)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(include))).mode & 0o777).toBe(0o700);
    expect(await executor.handle({ type: "logout" }, signal)).toEqual({
      status: "signed-out",
    });
    expect(await readFile(config, "utf8")).toBe(before);
    await expect(access(include)).rejects.toThrow();
    // A second sign-out, or a crash replayed, finds nothing more to remove.
    expect(await executor.handle({ type: "status" }, signal)).toEqual({
      status: "signed-out",
    });
    expect(await readFile(config, "utf8")).toBe(before);
  }, false);
});

it("repairs a sign-in or sign-out interrupted between its steps", async () => {
  await fixture(async ({ executor, root, env }) => {
    const signal = new AbortController().signal;
    const include = path.join(root, githubCredentialInclude);
    // Signed in, but the process stopped before the include was written.
    await writeFile(path.join(root, "login"), "fixture-user");
    expect(await executor.handle({ type: "status" }, signal)).toMatchObject({
      status: "signed-in",
    });
    expect(gitConfig(env, "include.path")).toBe(include);
    // Signed out by gh, but the process stopped before the include was removed.
    await rm(path.join(root, "login"));
    const fresh = new GitHubRunnerExecutor(
      env,
      executor["wrap"],
      undefined,
      undefined,
      true
    );
    gitConfig(env, "include.path", include);
    expect(
      execFileSync("git", ["config", "--global", "--get-all", "include.path"], {
        env,
        encoding: "utf8",
      })
    ).toBe(`${include}\n`);
    expect(await fresh.handle({ type: "status" }, signal)).toEqual({
      status: "signed-out",
    });
    expect(() => gitConfig(env, "include.path")).toThrow();
    await expect(access(include)).rejects.toThrow();
  });
});

it("binds bounded PR details and an assessed diff to the workload credential", async () => {
  await fixture(async ({ executor, root }) => {
    const target = { owner: "org", repo: "project", number: 42 };
    const signal = new AbortController().signal;
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const metadata = {
      number: 42,
      title: "Private PR",
      body: "Description",
      baseRefName: "main",
      headRefName: "fix",
      baseRefOid: base,
      headRefOid: head,
      additions: 1,
      deletions: 0,
    };
    const files = [{ path: "src/example.ts", additions: 1, deletions: 0 }];
    const writeDetails = (hasNextPage: boolean) =>
      writeFile(
        path.join(root, "detail-response"),
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                ...metadata,
                files: { pageInfo: { hasNextPage }, nodes: files },
              },
            },
          },
        })
      );
    await writeFile(path.join(root, "active-token"), "approved-token");
    await writeDetails(false);
    await writeFile(
      path.join(root, "compare-path"),
      `repos/org/project/compare/${base}...${head}`
    );
    const details = await executor.handle(
      { ...target, type: "pullRequestDetails" },
      signal
    );
    expect(details).toEqual({
      ...metadata,
      files,
      credentialContext: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    if (
      !details ||
      !("credentialContext" in details) ||
      !details.credentialContext
    )
      throw new Error("Missing credential context");
    const diff = {
      ...target,
      type: "pullRequestDiff" as const,
      base,
      head,
      credentialContext: details.credentialContext,
    };
    expect(await executor.handle(diff, signal)).toEqual({
      files: [{ ...files[0], patch: "@@ -1 +1 @@" }],
    });
    await writeDetails(true);
    expect(
      await executor.handle({ ...target, type: "pullRequestDetails" }, signal)
    ).toBeNull();
    await writeFile(path.join(root, "active-token"), "denied-token");
    expect(await executor.handle(diff, signal)).toBeNull();
    await expect(
      executor.handle({ ...target, type: "pullRequestDetails" }, signal)
    ).rejects.toThrow();
  });
});

it("clears pending device codes on cancel, disconnect and failed authorization", async () => {
  await fixture(async ({ executor, root }) => {
    let controller = new AbortController();
    const handle = (type: "status" | "login" | "cancel") =>
      executor.handle({ type }, controller.signal);
    const pending = async () => {
      await handle("login");
      await codeShown(executor);
      expect(await handle("status")).toMatchObject({
        status: "pending",
        code: "ABCD-1234",
      });
    };
    try {
      await pending();
      expect(await handle("cancel")).toEqual({ status: "signed-out" });
      await pending();
      const disconnected = executor["login"]!.finished;
      controller.abort();
      controller = new AbortController();
      await disconnected;
      expect(await handle("status")).toEqual({ status: "signed-out" });
      await pending();
      const rejected = executor["login"]!.finished;
      await writeFile(path.join(root, "reject"), "");
      await rejected;
      expect(await handle("status")).toEqual({
        status: "failed",
        message:
          "GitHub device authorization did not finish. Start sign-in again.",
      });
    } finally {
      controller.abort();
    }
  });
});

it("returns the device code and signs out with the Ubuntu 22.04 single-account CLI", async () => {
  await fixture(async ({ executor, root }) => {
    const connection = new AbortController();
    try {
      await writeFile(path.join(root, "legacy"), "");
      await writeFile(
        path.join(root, "gh-version"),
        "gh version 2.4.0+dfsg1 (Ubuntu)"
      );
      await executor.handle({ type: "login" }, connection.signal);
      await codeShown(executor);
      expect(
        await executor.handle({ type: "status" }, connection.signal)
      ).toMatchObject({
        status: "pending",
        code: "ABCD-1234",
        verificationUrl: "https://github.com/login/device",
      });
      const authorized = executor["login"]!.finished;
      await writeFile(path.join(root, "authorize"), "");
      await authorized;
      expect(
        await executor.handle({ type: "status" }, connection.signal)
      ).toMatchObject({ status: "signed-in" });
      expect(
        await executor.handle({ type: "logout" }, connection.signal)
      ).toMatchObject({ status: "signed-out" });
    } finally {
      connection.abort();
    }
  });
});

it("uses host-only logout only for the verified single-account CLI version", async () => {
  await fixture(async ({ executor, root }) => {
    const signal = new AbortController().signal;
    await writeFile(path.join(root, "login"), "fixture-user");
    await writeFile(path.join(root, "gh-version"), "gh version 2.24.0");
    expect(await executor.handle({ type: "logout" }, signal)).toEqual({
      status: "failed",
      message: "GitHub CLI could not sign out the workload account.",
    });
    expect(await executor.handle({ type: "status" }, signal)).toEqual({
      status: "signed-in",
      login: "fixture-user",
    });
    await writeFile(
      path.join(root, "gh-version"),
      "gh version 2.23.0 (Debian)"
    );
    expect(await executor.handle({ type: "logout" }, signal)).toEqual({
      status: "signed-out",
    });
  });
});

it("keeps the include when an account read fails or times out", async () => {
  await fixture(async ({ executor, root, env }) => {
    const include = path.join(root, githubCredentialInclude);
    await writeFile(path.join(root, "login"), "fixture-user");
    const signal = new AbortController().signal;
    expect(await executor.handle({ type: "status" }, signal)).toMatchObject({
      status: "signed-in",
    });
    await writeFile(path.join(root, "api-down"), "");
    expect(await executor.handle({ type: "status" }, signal)).toMatchObject({
      status: "unavailable",
    });
    await rm(path.join(root, "api-down"));
    await writeFile(path.join(root, "hold-user"), "");
    const timeout = new AbortController();
    const read = executor.handle({ type: "status" }, timeout.signal);
    while (
      !(await access(path.join(root, "user-started")).then(
        () => true,
        () => false
      ))
    )
      await delay(20);
    timeout.abort();
    expect(await read).toMatchObject({ status: "unavailable" });
    await writeFile(path.join(root, "release-user"), "");
    expect(gitConfig(env, "include.path")).toBe(include);
    await access(include);
  });
});

it("adds the include once when two runner processes read the account together", async () => {
  await fixture(async ({ executor, root, env }) => {
    const include = path.join(root, githubCredentialInclude);
    await writeFile(path.join(root, "login"), "fixture-user");
    const other = new GitHubRunnerExecutor(
      env,
      executor["wrap"],
      undefined,
      undefined,
      true
    );
    const signal = new AbortController().signal;
    for (let round = 0; round < 3; round++) {
      other["credentialState"] = undefined;
      executor["credentialState"] = undefined;
      await Promise.all(
        [executor, other, executor].map((reader) =>
          reader.handle({ type: "status" }, signal)
        )
      );
    }
    expect(
      execFileSync("git", ["config", "--global", "--get-all", "include.path"], {
        env,
        encoding: "utf8",
      })
    ).toBe(`${include}\n`);
  });
});

it("writes under the configured home whatever GIT_CONFIG_GLOBAL or XDG_CONFIG_HOME say", async () => {
  await fixture(async ({ executor, root, env }) => {
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    const redirected = new GitHubRunnerExecutor(
      {
        ...env,
        GIT_CONFIG_GLOBAL: path.join(elsewhere, "gitconfig"),
        XDG_CONFIG_HOME: elsewhere,
      },
      executor["wrap"],
      undefined,
      undefined,
      true
    );
    await writeFile(path.join(root, "login"), "fixture-user");
    const signal = new AbortController().signal;
    expect(await redirected.handle({ type: "status" }, signal)).toMatchObject({
      status: "signed-in",
    });
    const include = path.join(root, githubCredentialInclude);
    expect(
      execFileSync(
        "git",
        ["config", "--file", path.join(root, ".gitconfig"), "include.path"],
        { encoding: "utf8" }
      )
    ).toBe(`${include}\n`);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await redirected.handle({ type: "logout" }, signal)).toEqual({
      status: "signed-out",
    });
    await expect(access(include)).rejects.toThrow();
    expect(await readdir(elsewhere)).toEqual([]);
  });
});
