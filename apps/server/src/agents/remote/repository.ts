import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseRunnerRepositoryUrl,
  validBranch,
  type RepositoryCheckout,
} from "./protocol.js";
export { validBranch };

export type RepositoryInput = { url?: string; checkout: RepositoryCheckout };
/**
 * A launch's repository: a raw checkout plan (older clients), or only the
 * origin, whose checkout comes from the launch's worktree intent.
 */
export type RepositoryTarget = { url?: string; checkout?: RepositoryCheckout };

export function parseRepositoryTarget(input: unknown): RepositoryTarget {
  if (input && typeof input === "object" && !("checkout" in input)) {
    if (!("url" in input) || input.url === undefined) return {};
    if (typeof input.url !== "string")
      throw new Error("Repository URL must be a string.");
    return { url: repositoryUrl(input.url) };
  }
  return parseRepository(input);
}

export function repositoryUrl(input: string, fromOrigin = false): string {
  let source = input;
  if (fromOrigin) {
    const ssh = /^(?:git@|ssh:\/\/git@)([\w.-]+)[:/]([\w./-]+)$/.exec(input);
    if (ssh) source = `https://${ssh[1]}/${ssh[2]}`;
  }
  const invalid = () =>
    new Error("Runner repositories require a credential-free HTTPS Git URL.");
  const url = parseRunnerRepositoryUrl(source, fromOrigin);
  if (!url) throw invalid();
  url.username = "";
  url.password = "";
  return url.href;
}

export function parseRepository(input: unknown): RepositoryInput {
  if (!input || typeof input !== "object" || !("checkout" in input))
    throw new Error("A runner repository requires a checkout.");
  let url: string | undefined;
  if ("url" in input && input.url !== undefined) {
    if (typeof input.url !== "string")
      throw new Error("Repository URL must be a string.");
    url = repositoryUrl(input.url);
  }
  const checkout = input.checkout;
  if (!checkout || typeof checkout !== "object" || !("kind" in checkout))
    throw new Error("A valid checkout branch is required.");
  if (checkout.kind === "default") {
    if ("branch" in checkout && checkout.branch !== undefined)
      throw new Error("A default checkout resolves its branch on the runner.");
    return { url, checkout: { kind: "default" } };
  }
  if (!("branch" in checkout) || !validBranch(checkout.branch))
    throw new Error("A valid checkout branch is required.");
  const { branch } = checkout;
  switch (checkout.kind) {
    case "new": {
      const base = "base" in checkout ? checkout.base : undefined;
      if (base !== undefined && !validBranch(base))
        throw new Error("The checkout base must be a valid branch name.");
      return { url, checkout: { kind: "new", branch, base } };
    }
    case "branch": {
      const allowDefault =
        "allowDefault" in checkout ? checkout.allowDefault : undefined;
      if (allowDefault !== undefined && allowDefault !== true)
        throw new Error("allowDefault must be true when provided.");
      return {
        url,
        checkout: {
          kind: "branch",
          branch,
          ...(allowDefault && { allowDefault }),
        },
      };
    }
    case "pr": {
      const number = "number" in checkout ? checkout.number : undefined;
      if (
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1
      )
        throw new Error("The pull request number must be a positive integer.");
      return { url, checkout: { kind: "pr", branch, number } };
    }
    default:
      throw new Error("Checkout kind must be new, branch, default, or pr.");
  }
}

const execute = promisify(execFile);

export async function inferRepositoryUrl(cwd: string): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
  );
  try {
    const { stdout } = await execute(
      "git",
      [
        "-C",
        cwd,
        "config",
        "--local",
        "--no-includes",
        "--null",
        "--get-all",
        "remote.origin.url",
      ],
      { env, timeout: 5_000, maxBuffer: 8_192 }
    );
    const [origin, end, ...extra] = stdout.split("\0");
    if (origin && end === "" && extra.length === 0)
      return repositoryUrl(origin, true);
  } catch {
    // Git or the origin may be unavailable. Never expose raw origin text.
  }
  throw new Error(
    "The project has no unambiguous HTTPS repository origin. Enter its repository URL."
  );
}
