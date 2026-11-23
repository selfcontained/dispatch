/*
 * A repository's identity on a runner: one cached clone per repository,
 * whichever spelling of its URL a request uses. The host is lowercased,
 * credentials and the user are dropped, and a trailing `.git` and `/` are
 * stripped, so `git@host:o/r.git`, `ssh://git@host/o/r` and
 * `https://host/o/r` share a clone. The transport and its user are the
 * account's Git's business, not the clone's identity.
 */
import { createHash } from "node:crypto";

const SCP = /^(?:[^@/:]+@)?([^/:]+):(?!\/\/)(.+)$/;

function trimPath(path: string) {
  return path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");
}

/** `host/path` for a repository URL, or null when it is not one. */
export function repositoryIdentity(url: string): string | null {
  const text = url.trim();
  if (!text) return null;
  if (text.startsWith("/")) {
    const path = trimPath(text);
    return path ? `file/${path}` : null;
  }
  if (!text.includes("://")) {
    const scp = SCP.exec(text);
    if (!scp) return null;
    const path = trimPath(scp[2]!);
    return path ? `${scp[1]!.toLowerCase()}/${path}` : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const path = trimPath(decodeURIComponent(parsed.pathname));
  if (!path) return null;
  return parsed.protocol === "file:"
    ? `file/${path}`
    : `${parsed.host.toLowerCase()}/${path}`;
}

/** The cache key of a repository: a digest of its identity. */
export function repositoryKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * The URL as it may be stored and given to Git: an HTTP(S) URL's
 * credentials are dropped (the account's credential helper supplies them);
 * other transports keep their user, which names the account, not a secret.
 */
export function storableUrl(url: string): string {
  const text = url.trim();
  if (!/^https?:\/\//i.test(text)) return text;
  const parsed = new URL(text);
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

/** The last path segment of the identity, as a directory name. */
export function repositoryName(identity: string): string {
  const name = identity.split("/").pop() ?? "";
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== ".."
    ? name
    : "repository";
}
