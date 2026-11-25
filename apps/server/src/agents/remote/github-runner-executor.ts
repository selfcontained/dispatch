import {
  GitHubPullRequestEvidence,
  nativeGitHubEvidence,
} from "../github-pull-request-evidence.js";
import {
  pullRequestObservation,
  pullRequestQueryArgs,
} from "../pull-request-reader.js";
import {
  runCommand,
  type CommandRunner,
} from "../../shared/lib/run-command.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  githubDeviceUrl,
  githubAccountIssues,
  githubPullRequestHead,
  githubPullRequestTargetKey,
  githubRepositoryResults,
  validGitHubLogin,
  validBranch,
  type GitHubChangedFile,
  type GitHubOperation,
  type GitHubPullRequestDetails,
  type GitHubPullRequestDiff,
  type GitHubPullRequestObservation,
  type GitHubPullRequestTarget,
  type GitHubStatus,
} from "@dispatch/runner-protocol";
import {
  fixedWorkloadTools,
  githubCredentialHelper,
  githubCredentialKey,
  missingExecutable,
  type WorkloadTool,
  type WorkloadToolResolver,
} from "./workload-tools.js";

const host = "github.com";
const hostArgs = ["--hostname", host];
const execute = promisify(execFile);
const codePattern = /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})\r?\n/i;
/**
 * The workload account's plain git reads the login gh already holds through
 * this file, included from its global configuration while it is signed in.
 * Only the helper command is written; the token stays in gh's own store.
 */
export const githubCredentialInclude =
  ".config/dispatch-runner/github-credential.gitconfig";

/** A literal value as a POSIX extended regular expression. */
function exactPattern(value: string) {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function cliIssue(error: unknown, fallback: string) {
  const { stderr } = error as { stderr?: string };
  if (missingExecutable(error)) return githubAccountIssues.missing;
  if (
    /network is unreachable|no such host|could not resolve host|connection refused|error connecting to (?:api\.)?github\.com/i.test(
      stderr ?? ""
    )
  )
    return githubAccountIssues.network;
  return fallback;
}

/**
 * `github.pr.status` for one workload account, on every placement: the
 * credential-scoped read first, else the plain query, whose answer (or
 * failure) is shared for a minute by every caller of the same pull request.
 * Each platform supplies how its commands run.
 */
export class GitHubPullRequestStatus {
  private plainReads = new Map<
    string,
    { expires: number; value: Promise<GitHubPullRequestObservation> }
  >();

  constructor(
    private readonly evidence: Pick<GitHubPullRequestEvidence, "status"> | null,
    /** The query's stdout; a usable answer with check-level errors included. */
    private readonly plain: (args: string[]) => Promise<string>
  ) {}

  async read(
    target: GitHubPullRequestTarget,
    signal?: AbortSignal,
    scoped = true
  ): Promise<GitHubPullRequestObservation> {
    if (scoped && this.evidence) {
      const deadline = AbortSignal.timeout(12_000);
      const observation = await this.evidence
        .status(target, signal ? AbortSignal.any([signal, deadline]) : deadline)
        .catch(() => null);
      if (observation) return observation;
    }
    const key = githubPullRequestTargetKey(target);
    const now = Date.now();
    const cached = this.plainReads.get(key);
    if (cached && cached.expires > now) return cached.value;
    for (const [entry, { expires }] of this.plainReads)
      if (expires <= now) this.plainReads.delete(entry);
    const value = this.plain(
      pullRequestQueryArgs(target.owner, target.repo, String(target.number))
    ).then((stdout) => pullRequestObservation(JSON.parse(stdout)));
    value.catch(() => {});
    this.plainReads.set(key, { expires: now + 60_000, value });
    return value;
  }

  /** A changed account cannot reuse the previous account's answers. */
  reset() {
    this.plainReads.clear();
  }
}

/** The local runner's reads: the user's own `gh`, as the app ran it. */
export function localPullRequestStatus(
  run: CommandRunner = runCommand,
  evidence: Pick<
    GitHubPullRequestEvidence,
    "status"
  > | null = nativeGitHubEvidence()
) {
  return new GitHubPullRequestStatus(
    evidence,
    async (args) =>
      (
        await run("gh", args, {
          timeoutMs: 10_000,
          allowedExitCodes: [0, 1],
        })
      ).stdout
  );
}

/** A pull request as main's merge-risk read it with `gh pr view`. */
export type PullRequestDetails = {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  files: { path: string; additions: number; deletions: number }[];
  statusCheckRollup: unknown;
};

/** `gh pr view` for one pull request; null when gh cannot read it. */
export async function readPullRequestDetails(
  { owner, repo, number }: { owner: string; repo: string; number: number },
  run: CommandRunner = runCommand
): Promise<PullRequestDetails | null> {
  const result = await run(
    "gh",
    [
      "pr",
      "view",
      String(number),
      "--repo",
      `${owner}/${repo}`,
      "--json",
      "number,title,body,state,isDraft,mergedAt,additions,deletions,baseRefName,headRefName,headRefOid,files,statusCheckRollup",
    ],
    { timeoutMs: 30_000, allowedExitCodes: [0, 1] }
  );
  if (result.exitCode !== 0) return null;
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    number: num(parsed.number),
    title: str(parsed.title),
    body: str(parsed.body),
    state: str(parsed.state),
    isDraft: parsed.isDraft === true,
    mergedAt: typeof parsed.mergedAt === "string" ? parsed.mergedAt : null,
    additions: num(parsed.additions),
    deletions: num(parsed.deletions),
    baseRefName: str(parsed.baseRefName),
    headRefName: str(parsed.headRefName),
    headRefOid: str(parsed.headRefOid),
    files: Array.isArray(parsed.files)
      ? parsed.files.flatMap((f: unknown) => {
          const file = f as Record<string, unknown>;
          return typeof file?.path === "string"
            ? [
                {
                  path: file.path,
                  additions: num(file.additions),
                  deletions: num(file.deletions),
                },
              ]
            : [];
        })
      : [],
    statusCheckRollup: parsed.statusCheckRollup,
  };
}

/**
 * The local runner's merge-risk evidence: the user's own `gh`, with main's
 * commands. Reads are not scoped to a credential, so details name none and
 * a diff without a base compares from the pull request's current base.
 */
export function localPullRequestEvidence(run: CommandRunner = runCommand) {
  return {
    async details(
      target: GitHubPullRequestTarget
    ): Promise<Omit<
      GitHubPullRequestDetails,
      "credentialContext" | "baseRefOid"
    > | null> {
      const details = await readPullRequestDetails(target, run);
      if (!details) return null;
      return {
        number: details.number,
        title: details.title,
        body: details.body,
        baseRefName: details.baseRefName,
        headRefName: details.headRefName,
        headRefOid: details.headRefOid,
        additions: details.additions,
        deletions: details.deletions,
        files: details.files,
      };
    },
    async diff({
      owner,
      repo,
      number,
      base,
      head,
    }: GitHubPullRequestTarget & {
      base?: string;
      head: string;
    }): Promise<(GitHubPullRequestDiff & { base?: string }) | null> {
      try {
        const repository = `${owner}/${repo}`;
        if (!/^[0-9a-f]{7,40}$/i.test(head)) return null;
        if (base === undefined) {
          const pull = await run(
            "gh",
            ["api", `repos/${repository}/pulls/${number}`, "--jq", ".base.sha"],
            { timeoutMs: 15_000, allowedExitCodes: [0, 1] }
          );
          base = pull.stdout.trim();
          if (pull.exitCode !== 0) return null;
        }
        if (!/^[0-9a-f]{40}$/i.test(base)) return null;
        const compare = await run(
          "gh",
          [
            "api",
            `repos/${repository}/compare/${base}...${head}`,
            "--jq",
            "[.files[] | {path: .filename, additions, deletions, patch}]",
          ],
          { timeoutMs: 20_000, allowedExitCodes: [0, 1] }
        );
        if (compare.exitCode !== 0) return null;
        const parsed: unknown = JSON.parse(compare.stdout);
        if (!Array.isArray(parsed)) return null;
        const files: GitHubChangedFile[] = parsed.flatMap((raw) => {
          const f = raw as Record<string, unknown>;
          return typeof f?.path === "string"
            ? [
                {
                  path: f.path,
                  additions: Number(f.additions) || 0,
                  deletions: Number(f.deletions) || 0,
                  ...(typeof f.patch === "string" ? { patch: f.patch } : {}),
                },
              ]
            : [];
        });
        return { base, files };
      } catch {
        return null;
      }
    },
  };
}

type Login = {
  connection: AbortSignal;
  child: ChildProcess;
  finished: Promise<void>;
  code?: string;
};

type RepositoryRows = { name?: unknown; url?: unknown }[];

type CommandWrapper = (
  bin: string,
  args: string[]
) => {
  bin: string;
  args: string[];
};

/** Commands run with the same workload HOME as checkout and agents. */
export class GitHubRunnerExecutor {
  private readonly evidence: GitHubPullRequestEvidence;
  private readonly status: GitHubPullRequestStatus;
  private readonly env: NodeJS.ProcessEnv;
  private login?: Login;
  private failure?: string;
  private queue = Promise.resolve();
  private accountChangesPending = 0;
  /** The helper this process last confirmed in place, or "absent". */
  private credentialState?: string;
  private credentialQueue = Promise.resolve();
  private repositoryGeneration = 0;
  private repositories?: {
    at: number;
    pages: Map<number, Promise<RepositoryRows>>;
  };

  private repositoryPage(page: number) {
    if (!this.repositories || Date.now() - this.repositories.at >= 5 * 60_000)
      this.repositories = { at: Date.now(), pages: new Map() };
    const { pages } = this.repositories;
    const cached = pages.get(page);
    if (cached) return cached;

    const pending = this.run(
      [
        "api",
        ...hostArgs,
        "user/repos",
        "--method",
        "GET",
        "-f",
        "affiliation=owner,collaborator,organization_member",
        "-f",
        "sort=pushed",
        "-f",
        "per_page=100",
        "-f",
        `page=${page}`,
        "--jq",
        "[.[] | {name: .full_name, url: .html_url}]",
      ],
      AbortSignal.timeout(7_000)
    ).then((result) => {
      const rows: unknown = JSON.parse(result);
      if (!Array.isArray(rows))
        throw new Error("Invalid GitHub repository list.");
      return rows as RepositoryRows;
    });
    pages.set(page, pending);
    void pending.catch(() => pages.delete(page));
    return pending;
  }

  private async searchRepositories(query: string, signal: AbortSignal) {
    if (this.accountChangesPending || this.login)
      throw new Error("GitHub account change is in progress.");
    const generation = this.repositoryGeneration;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(18_000)]);
    const checkAccount = () => {
      deadline.throwIfAborted();
      if (generation !== this.repositoryGeneration)
        throw new Error("GitHub account changed during repository search.");
    };

    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(deadline.reason);
    deadline.addEventListener("abort", onAbort, { once: true });
    try {
      const repositories: { name: string; url: string }[] = [];
      const seen = new Set<string>();
      for (let first = 1; ; first += 4) {
        checkAccount();
        // Reuse the cached pages, but consume each in order so page two cannot
        // delay returning a complete first page of matches.
        const batch = [0, 1, 2, 3].map((offset) =>
          this.repositoryPage(first + offset)
        );
        for (const pending of batch) {
          const rows = await Promise.race([pending, aborted]).catch(
            (error: unknown) => {
              checkAccount();
              if (repositories.length) return [];
              throw error;
            }
          );
          checkAccount();
          for (const row of rows) {
            if (
              typeof row?.name !== "string" ||
              !row.name.toLowerCase().includes(query)
            )
              continue;
            const [repository] = githubRepositoryResults([row]).repositories;
            if (!repository || seen.has(repository.url)) continue;
            seen.add(repository.url);
            repositories.push(repository);
            if (repositories.length === 12) return { repositories };
          }
          if (rows.length < 100) return { repositories };
        }
      }
    } finally {
      deadline.removeEventListener("abort", onAbort);
    }
  }

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly wrap: CommandWrapper,
    credentialKey?: Buffer,
    private readonly tools: WorkloadToolResolver = fixedWorkloadTools,
    private readonly managePrivateGitIdentity = false
  ) {
    // Global Git writes belong to the configured home's ~/.gitconfig.
    const { GIT_CONFIG_GLOBAL: _redirect, ...accountEnv } = env;
    this.env = {
      ...accountEnv,
      GH_HOST: host,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      LC_ALL: "C",
    };
    this.evidence = new GitHubPullRequestEvidence(
      this.run.bind(this),
      credentialKey
    );
    this.status = new GitHubPullRequestStatus(this.evidence, (args) =>
      this.run(args, AbortSignal.timeout(17_000)).catch((error) => {
        // GraphQL can return a usable PR and a check-level error together.
        if (
          error.code === 1 &&
          typeof error.stdout === "string" &&
          error.stdout
        )
          return error.stdout;
        throw error;
      })
    );
  }

  private run(args: string[], signal: AbortSignal, token?: string) {
    return this.runCommand("gh", args, signal, token);
  }

  private async runCommand(
    tool: WorkloadTool,
    args: string[],
    signal: AbortSignal,
    token?: string
  ) {
    const command = this.wrap(await this.tools.resolve(tool), args);
    try {
      const { stdout } = await execute(command.bin, command.args, {
        env: token ? { ...this.env, GH_TOKEN: token } : this.env,
        signal,
        killSignal: "SIGKILL",
        timeout: 7_000,
        maxBuffer: 128 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      if (missingExecutable(error)) this.tools.invalidate();
      throw error;
    }
  }

  private async configureGitIdentity(
    profile: { login: string; id: number; name?: unknown },
    signal: AbortSignal
  ) {
    const config = (args: string[]) =>
      this.runCommand("git", ["config", "--global", ...args], signal);
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    for (const [key, value] of [
      ["user.name", name || profile.login],
      ["user.email", `${profile.id}+${profile.login}@users.noreply.github.com`],
    ]) {
      try {
        await config(["--get", key]);
      } catch (error) {
        if (
          !this.managePrivateGitIdentity ||
          (error as { code?: number }).code !== 1
        )
          throw error;
        await config([key, value]);
      }
    }
  }

  private async runWorkload(bin: string, args: string[], signal: AbortSignal) {
    const command = this.wrap(bin, args);
    await execute(command.bin, command.args, {
      env: this.env,
      signal,
      killSignal: "SIGKILL",
      timeout: 7_000,
      maxBuffer: 16 * 1024,
    });
  }

  /**
   * Both paths come from the account's configured home, never from
   * GIT_CONFIG_GLOBAL or XDG_CONFIG_HOME, which a shell can point elsewhere.
   * ~/.gitconfig is always part of the account's global configuration.
   */
  private credentialPaths() {
    const home = this.env.HOME;
    if (!home || !path.isAbsolute(home))
      throw new Error("The workload account has no home directory.");
    return {
      config: path.join(home, ".gitconfig"),
      file: path.join(home, githubCredentialInclude),
    };
  }

  /** Point the account's plain git at gh's login for github.com. */
  private async addCredentialHelper(signal: AbortSignal) {
    const helper = githubCredentialHelper(await this.tools.resolve("gh"));
    if (this.credentialState === helper) return;
    const { config, file } = this.credentialPaths();
    this.credentialState = undefined;
    await this.runWorkload(
      "/bin/mkdir",
      ["-p", "-m", "700", path.dirname(file)],
      signal
    );
    await this.runCommand(
      "git",
      ["config", "--file", file, "--replace-all", githubCredentialKey, helper],
      signal
    );
    await this.runWorkload("/bin/chmod", ["600", file], signal);
    // One locked write: replaces our exact line, or adds it when absent, so
    // concurrent or repeated sign-ins never add a second line.
    await this.runCommand(
      "git",
      [
        "config",
        "--file",
        config,
        "--replace-all",
        "include.path",
        file,
        exactPattern(file),
      ],
      signal
    );
    this.credentialState = helper;
  }

  /** Remove exactly what addCredentialHelper wrote; safe to repeat. */
  private async removeCredentialHelper(signal: AbortSignal) {
    if (this.credentialState === "absent") return;
    const { config, file } = this.credentialPaths();
    this.credentialState = undefined;
    try {
      await this.runCommand(
        "git",
        [
          "config",
          "--file",
          config,
          "--unset-all",
          "include.path",
          exactPattern(file),
        ],
        signal
      );
    } catch (error) {
      // 5: nothing matched; 1: no ~/.gitconfig. Nothing to remove either way.
      const { code } = error as { code?: number };
      if (code !== 5 && code !== 1) throw error;
    }
    await this.runWorkload("/bin/rm", ["-f", file], signal);
    await this.runWorkload("/bin/rmdir", [path.dirname(file)], signal).catch(
      () => {}
    );
    this.credentialState = "absent";
  }

  /** One change at a time; a failure is retried on the next account read. */
  private syncCredentialHelper(signedIn: boolean, signal: AbortSignal) {
    const change = this.credentialQueue.then(() =>
      signedIn
        ? this.addCredentialHelper(signal)
        : this.removeCredentialHelper(signal)
    );
    this.credentialQueue = change.catch(() => {});
    return change.catch(() => {
      signal.throwIfAborted();
    });
  }

  private async configuredUser(signal: AbortSignal) {
    try {
      const login = await this.run(
        ["config", "get", "user", "--host", host],
        signal
      );
      if (validGitHubLogin(login)) return login;
      if (login) throw new Error("Invalid configured GitHub user.");
      // Older packaged gh can return success with an empty value.
    } catch (error) {
      const { code, stderr } = error as { code?: number; stderr?: string };
      if (code !== 1) throw error;
      if (stderr?.trim() === 'could not find key "user"') return undefined;
    }

    try {
      await this.run(["auth", "status", ...hostArgs], signal);
    } catch (error) {
      const { code, stderr } = error as { code?: number; stderr?: string };
      if (
        code === 1 &&
        /^You are not logged into any GitHub hosts\.(?: To log in, run: gh auth login| Run gh auth login to authenticate\.)?$/.test(
          stderr?.trim() ?? ""
        )
      )
        return undefined;
      throw error;
    }
    throw new Error("GitHub CLI did not identify the configured user.");
  }

  private async account(signal: AbortSignal): Promise<GitHubStatus> {
    const account = await this.readAccount(signal);
    if (account.status === "signed-in" || account.status === "signed-out")
      await this.syncCredentialHelper(account.status === "signed-in", signal);
    return account;
  }

  private async readAccount(signal: AbortSignal): Promise<GitHubStatus> {
    if (!(await this.configuredUser(signal))) return { status: "signed-out" };
    let profile: { login?: unknown; id?: unknown; name?: unknown } | null;
    try {
      profile = JSON.parse(
        await this.run(
          ["api", ...hostArgs, "user", "--jq", "{login,id,name}"],
          signal
        )
      );
    } catch (error) {
      const { code, stderr } = error as { code?: number; stderr?: string };
      if (code === 4 || /HTTP 401\b/.test(stderr ?? ""))
        return { status: "signed-out" };
      return {
        status: "unavailable",
        message: cliIssue(error, githubAccountIssues.verify),
      };
    }
    if (
      validGitHubLogin(profile?.login) &&
      typeof profile.id === "number" &&
      Number.isSafeInteger(profile.id) &&
      profile.id > 0
    ) {
      try {
        await this.configureGitIdentity(
          { login: profile.login, id: profile.id, name: profile.name },
          signal
        );
      } catch {
        signal.throwIfAborted();
        return {
          status: "signed-in",
          login: profile.login,
          gitIdentityUnavailable: true,
        };
      }
      return { status: "signed-in", login: profile.login };
    }
    return { status: "unavailable", message: githubAccountIssues.verify };
  }

  private currentLogin(): GitHubStatus {
    const code = this.login?.code;
    return code
      ? { status: "pending", code, verificationUrl: githubDeviceUrl }
      : { status: "pending" };
  }

  private start(connection: AbortSignal, gh: string) {
    const command = this.wrap(gh, [
      "auth",
      "login",
      ...hostArgs,
      "--web",
      // gh chooses the workload account's native store and falls back to
      // its private config when running headless without a keyring.
    ]);
    connection.throwIfAborted();
    const child = spawn(command.bin, command.args, {
      env: this.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const session: Login = { connection, child, finished: Promise.resolve() };
    this.login = session;
    let tail = "";
    let cancelled = false;
    let failure: string | undefined;
    let codeReceived = false;
    const cancel = () => {
      cancelled = true;
      session.code = undefined;
      child.kill("SIGKILL");
    };
    connection.addEventListener("abort", cancel, { once: true });
    const codeDeadline = setTimeout(() => {
      failure = githubAccountIssues.timeout;
      child.kill("SIGKILL");
    }, 30_000);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (cancelled || session.code) return;
      tail = (tail + chunk).slice(-2048);
      const match = codePattern.exec(tail);
      // The fixed github.com CLI flow can print the code before its browser hint.
      if (match?.[1]) {
        codeReceived = true;
        session.code = match[1].toUpperCase();
        clearTimeout(codeDeadline);
        tail = "";
      }
    });
    // Even a spawn error is followed by a close event.
    child.on("error", () => {});
    session.finished = new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    }).then(async (code) => {
      clearTimeout(timeout);
      clearTimeout(codeDeadline);
      session.code = undefined;
      if (code === 0) {
        this.status.reset();
        try {
          const account = await this.account(AbortSignal.timeout(7000));
          if (account.status !== "signed-in")
            failure = githubAccountIssues.verify;
        } catch {
          failure = githubAccountIssues.verify;
        }
      }
      connection.removeEventListener("abort", cancel);
      if (code !== 0 && missingExecutable({ stderr: tail }))
        this.tools.invalidate();
      if (code !== 0 && !failure)
        failure = cliIssue(
          { stderr: tail },
          codeReceived
            ? githubAccountIssues.authorization
            : githubAccountIssues.device
        );
      this.failure = cancelled || connection.aborted ? undefined : failure;
      this.login = undefined;
    });
  }

  private async stopLogin() {
    const session = this.login;
    if (!session) return;
    session.code = undefined;
    session.child.kill("SIGKILL");
    await session.finished;
    this.failure = undefined;
    this.repositories = undefined;
  }

  private async logout(login: string, signal: AbortSignal) {
    try {
      await this.run(["auth", "logout", ...hostArgs, "--user", login], signal);
    } catch (error) {
      const { stderr } = error as { stderr?: string };
      if (stderr?.split("\n", 1)[0] !== "unknown flag: --user") throw error;
      // These single-account packages remove the verified login by hostname.
      const version = await this.run(["--version"], signal);
      if (
        !/^gh version (?:2\.23\.0|2\.4\.0(?:\+dfsg\d+)?)(?:\s|$)/.test(
          version
        ) ||
        (await this.configuredUser(signal)) !== login
      )
        throw error;
      await this.run(["auth", "logout", ...hostArgs], signal);
    }
  }

  private async statusOperation(
    operation: GitHubOperation,
    signal: AbortSignal
  ): Promise<GitHubStatus> {
    signal.throwIfAborted();
    switch (operation.type) {
      case "status":
        if (this.login) return this.currentLogin();
        if (this.failure) return { status: "failed", message: this.failure };
        return this.account(signal).then((account) => {
          // The form asks for the account before anyone searches, so the
          // first search finds the listing already under way.
          if (account.status === "signed-in" && !this.accountChangesPending)
            void this.repositoryPage(1).catch(() => {});
          return account;
        });
      case "login": {
        if (this.login?.connection === signal) return this.currentLogin();
        await this.login?.finished;
        signal.throwIfAborted();
        this.failure = undefined;
        this.repositories = undefined;
        const account = await this.account(signal);
        if (account.status === "signed-out") {
          const gh = await this.tools.resolve("gh");
          signal.throwIfAborted();
          this.start(signal, gh);
          return this.currentLogin();
        }
        return account;
      }
      case "cancel":
        await this.stopLogin();
        return this.account(signal);
      case "logout": {
        await this.stopLogin();
        this.failure = undefined;
        this.repositories = undefined;
        const login = await this.configuredUser(signal);
        if (login) await this.logout(login, signal);
        return this.account(signal);
      }
      default:
        throw new Error("Invalid GitHub account operation.");
    }
  }

  async handle(operation: GitHubOperation, signal: AbortSignal) {
    signal.throwIfAborted();
    switch (operation.type) {
      case "repositorySearch":
        return this.searchRepositories(operation.query.toLowerCase(), signal);
      case "repositoryBranches": {
        const repository = `repos/${operation.owner}/${operation.repo}`;
        // The list is capped and alphabetical, so the default is asked for
        // by name. A failed lookup leaves the list usable without it.
        const [list, named] = await Promise.all([
          this.run(
            [
              "api",
              ...hostArgs,
              `${repository}/branches?per_page=100`,
              "--jq",
              "[.[].name]",
            ],
            signal
          ),
          this.run(
            ["api", ...hostArgs, repository, "--jq", ".default_branch"],
            signal
          ).catch(() => ""),
        ]);
        const rows: unknown = JSON.parse(list);
        if (!Array.isArray(rows))
          throw new Error("Invalid GitHub branch list.");
        const defaultBranch = named.trim();
        return {
          branches: rows.filter(validBranch),
          ...(validBranch(defaultBranch) && { defaultBranch }),
        };
      }
      case "pullRequestDetails":
        return this.evidence.details(operation, signal);
      case "pullRequestDiff":
        return this.evidence.diff(
          operation,
          AbortSignal.any([signal, AbortSignal.timeout(18000)])
        );
      case "pullRequestStatus": {
        // Older apps ask without a credential scope, and get none.
        const { owner, repo, number } = operation;
        return this.status.read(
          { owner, repo, number },
          signal,
          operation.withCredentialContext === true
        );
      }
      case "pullRequestHead": {
        const { owner, repo, number } = operation;
        const head = await this.run(
          [
            "api",
            ...hostArgs,
            `repos/${owner}/${repo}/pulls/${number}`,
            "--jq",
            "{url:.head.repo.clone_url,branch:.head.ref}",
          ],
          signal
        );
        return githubPullRequestHead(JSON.parse(head));
      }
      default: {
        const changesAccount = operation.type !== "status";
        if (changesAccount) {
          this.accountChangesPending++;
          this.repositoryGeneration++;
          this.repositories = undefined;
          this.status.reset();
        }
        const result = this.queue.then(() =>
          this.statusOperation(operation, signal)
        );
        this.queue = result.then(
          () => {},
          () => {}
        );
        try {
          return await result;
        } catch (error) {
          const message = cliIssue(
            error,
            operation.type === "logout"
              ? githubAccountIssues.logout
              : githubAccountIssues.account
          );
          return {
            status:
              operation.type === "status" ||
              message === githubAccountIssues.missing
                ? "unavailable"
                : "failed",
            message,
          };
        } finally {
          if (changesAccount) this.accountChangesPending--;
        }
      }
    }
  }
}
