import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { registerPersonaRoutes } from "../src/routes/personas.js";
vi.mock("../src/personas/resolve.js", () => ({
  listPersonas: async () => ({
    personas: [],
    warnings: [],
    refreshing: false,
    updatedAt: null,
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it.each([
  "both",
  "legacy",
  "neither",
  "directory",
  "unreadable",
  "dangling-legacy",
  "dangling-only",
  "fifo",
  "outside-link",
  "not-directory",
] as const)("pins main's folder picker F_OK bytes for %s", async (kind) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "presence-route-"))
  );
  roots.push(root);
  const repo = path.join(root, "repo"),
    primary = path.join(repo, ".agents/owners.json"),
    legacy = path.join(repo, ".dispatch/codeowners.json");
  await mkdir(repo);
  execFileSync("git", ["-C", repo, "init", "--quiet"]);
  await mkdir(path.dirname(primary));
  await mkdir(path.dirname(legacy));
  if (kind === "both" || kind === "unreadable")
    await writeFile(primary, "not parsed by presence");
  if (
    kind === "both" ||
    kind === "legacy" ||
    kind === "dangling-legacy" ||
    kind === "not-directory"
  )
    await writeFile(legacy, "legacy");
  if (kind === "directory") await mkdir(primary);
  if (kind === "unreadable") await chmod(primary, 0);
  if (kind === "dangling-legacy" || kind === "dangling-only")
    await symlink(path.join(root, "missing"), primary);
  if (kind === "fifo") execFileSync("mkfifo", [primary]);
  if (kind === "outside-link") {
    await writeFile(path.join(root, "external"), "outside");
    await symlink(path.join(root, "external"), primary);
  }
  if (kind === "not-directory") {
    await rm(path.dirname(primary), { recursive: true });
    await writeFile(path.dirname(primary), "file");
  }
  const app = Fastify();
  try {
    await registerPersonaRoutes(app, {
      agentManager: { checkoutReadRunners: () => ({}) },
      projects: {},
      streams: {},
      handleAgentError: () => {
        throw new Error("Unused");
      },
    } as never);
    const reply = await app.inject({
      method: "GET",
      url: "/api/v1/personas?cwd=" + encodeURIComponent(repo),
    });
    if (kind === "not-directory") {
      expect(reply.statusCode).toBe(400);
      expect(reply.body).toBe(
        JSON.stringify({
          error: `ENOTDIR: not a directory, access '${primary}'`,
        })
      );
    } else {
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe(
        JSON.stringify({
          personas: [],
          codeowners: kind !== "neither" && kind !== "dangling-only",
          refreshing: false,
          updatedAt: null,
        })
      );
    }
  } finally {
    await app.close();
    if (kind === "unreadable") await chmod(primary, 0o600);
  }
});
