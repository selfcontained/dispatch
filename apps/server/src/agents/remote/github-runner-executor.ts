import { GitHubPullRequestEvidence } from "../github-pull-request-evidence.js";
import {
  pullRequestObservation,
  pullRequestQueryArgs,
} from "../pull-request-reader.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  githubDeviceUrl,
  githubAccountIssues,
  githubPullRequestHead,
  githubRepositoryResults,
  validGitHubLogin,
  validBranch,
  type GitHubOperation,
  type GitHubStatus,
} from "./protocol.js";

const host = "github.com";
const gh = "/usr/bin/gh";
const hostArgs = ["--hostname", host];
const execute = promisify(execFile);
const codePattern = /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})\r?\n/i;

function cliIssue(error: unknown, fallback: string) {
  const { code, stderr } = error as { code?: string | number; stderr?: string };
  if (
    code === "ENOENT" ||
    /failed to execute \/usr\/bin\/gh: No such file or directory/.test(
      stderr ?? ""
    )
  )
    return githubAccountIssues.missing;
  if (
    /network is unreachable|no such host|could not resolve host|connection refused|error connecting to (?:api\.)?github\.com/i.test(
      stderr ?? ""
    )
  )
    return githubAccountIssues.network;
  return fallback;
}

type Login = {
  connection: AbortSignal;
  child: ChildProcess;
  finished: Promise<void>;
  code?: string;
};

type CommandWrapper = (
  bin: string,
  args: string[]
) => {
  bin: string;
  args: string[];
};

/** Commands run with the same dedicated workload HOME as checkout and agents. */
export class GitHubRunnerExecutor {
  private readonly evidence: GitHubPullRequestEvidence;
  private readonly env: NodeJS.ProcessEnv;
  private login?: Login;
  private failure?: string;
  private queue = Promise.resolve();

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly wrap: CommandWrapper,
    credentialKey?: Buffer
  ) {
    this.env = {
      ...env,
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
  }

  private async run(args: string[], signal: AbortSignal, token?: string) {
    const command = this.wrap(gh, args);
    const { stdout } = await execute(command.bin, command.args, {
      env: token ? { ...this.env, GH_TOKEN: token } : this.env,
      signal,
      killSignal: "SIGKILL",
      timeout: 7_000,
      maxBuffer: 128 * 1024,
    });
    return stdout.trim();
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
    if (!(await this.configuredUser(signal))) return { status: "signed-out" };
    try {
      const login = await this.run(
        ["api", ...hostArgs, "user", "--jq", ".login"],
        signal
      );
      if (validGitHubLogin(login)) return { status: "signed-in", login };
    } catch (error) {
      const { code, stderr } = error as { code?: number; stderr?: string };
      if (code === 4 || /HTTP 401\b/.test(stderr ?? ""))
        return { status: "signed-out" };
      return {
        status: "unavailable",
        message: cliIssue(error, githubAccountIssues.verify),
      };
    }
    return { status: "unavailable", message: githubAccountIssues.verify };
  }

  private currentLogin(): GitHubStatus {
    const code = this.login?.code;
    return code
      ? { status: "pending", code, verificationUrl: githubDeviceUrl }
      : { status: "pending" };
  }

  private start(connection: AbortSignal) {
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
        this.onLogin?.();
        try {
          // Ubuntu 22.04's gh supports setting the protocol through config,
          // but rejects --git-protocol on auth login before requesting a code.
          await this.run(
            ["config", "set", "git_protocol", "https", "--host", host],
            AbortSignal.timeout(7000)
          );
          await this.run(
            ["auth", "setup-git", ...hostArgs],
            AbortSignal.timeout(7000)
          );
        } catch {
          failure = githubAccountIssues.helper;
        }
      }
      connection.removeEventListener("abort", cancel);
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
        return this.account(signal);
      case "login": {
        if (this.login?.connection === signal) return this.currentLogin();
        await this.login?.finished;
        signal.throwIfAborted();
        this.failure = undefined;
        const account = await this.account(signal);
        if (account.status === "signed-out") {
          this.start(signal);
          return this.currentLogin();
        }
        if (account.status === "signed-in") {
          try {
            await this.run(["auth", "setup-git", ...hostArgs], signal);
          } catch {
            return { status: "failed", message: githubAccountIssues.helper };
          }
        }
        return account;
      }
      case "cancel":
        await this.stopLogin();
        return this.account(signal);
      case "logout": {
        await this.stopLogin();
        this.failure = undefined;
        const login = await this.configuredUser(signal);
        if (login) await this.logout(login, signal);
        return this.account(signal);
      }
      default:
        throw new Error("Invalid GitHub account operation.");
    }
  }

  onLogin?: () => void;

  async handle(operation: GitHubOperation, signal: AbortSignal) {
    signal.throwIfAborted();
    switch (operation.type) {
      case "repositorySearch": {
        const matches: { name: string; url: string }[] = [];
        const query = operation.query.toLowerCase();
        for (let page = 1; matches.length < 12; page++) {
          const rows: unknown = JSON.parse(
            await this.run(
              [
                "api",
                ...hostArgs,
                "user/repos",
                "--method",
                "GET",
                "-f",
                "affiliation=owner,collaborator,organization_member",
                "-f",
                "per_page=100",
                "-f",
                `page=${page}`,
                "--jq",
                "[.[] | {name: .full_name, url: .html_url}]",
              ],
              signal
            )
          );
          if (!Array.isArray(rows))
            throw new Error("Invalid GitHub repository list.");
          matches.push(
            ...githubRepositoryResults(
              rows.filter(
                (row) =>
                  typeof row?.name === "string" &&
                  row.name.toLowerCase().includes(query)
              )
            ).repositories
          );
          if (rows.length < 100) break;
        }
        return githubRepositoryResults(matches);
      }
      case "repositoryBranches": {
        const rows: unknown = JSON.parse(
          await this.run(
            [
              "api",
              ...hostArgs,
              `repos/${operation.owner}/${operation.repo}/branches?per_page=100`,
              "--jq",
              "[.[].name]",
            ],
            signal
          )
        );
        if (!Array.isArray(rows))
          throw new Error("Invalid GitHub branch list.");
        return { branches: rows.filter(validBranch) };
      }
      case "pullRequestDetails":
        return this.evidence.details(operation, signal);
      case "pullRequestDiff":
        return this.evidence.diff(
          operation,
          AbortSignal.any([signal, AbortSignal.timeout(18000)])
        );
      case "pullRequestStatus": {
        if (operation.withCredentialContext) {
          // Older workload installations may support the status query but
          // lack an exportable credential. Keep status usable without a scope.
          const scoped = await this.evidence
            .status(operation, signal)
            .catch(() => null);
          if (scoped) return scoped;
        }
        const { owner, repo, number } = operation;
        const result = await this.run(
          pullRequestQueryArgs(owner, repo, String(number)),
          signal
        ).catch((error) => {
          // GraphQL can return a usable PR and a check-level error together.
          if (
            error.code === 1 &&
            typeof error.stdout === "string" &&
            error.stdout
          )
            return error.stdout;
          throw error;
        });
        return pullRequestObservation(JSON.parse(result));
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
        }
      }
    }
  }
}
