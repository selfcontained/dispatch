// Steps the scenarios share.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VE3D7wAAAAASUVORK5CYII=",
  "base64"
);

export const agentPath = (id, rest = "") => `/api/v1/agents/${id}${rest}`;
export const blocksPath = (id) => `/api/v1/streams/${id}/blocks`;

export const toolsFile = (tools, hooks) =>
  `${JSON.stringify({ tools, ...(hooks && { hooks }) }, null, 2)}\n`;

export const persona = (name, body = "Review carefully.", type) =>
  `---\nname: ${name}\ndescription: The ${name} persona\n${type ? `type: ${type}\n` : ""}---\n\n${body}\n`;

export const owners = (personas = ["keeper"]) =>
  `${JSON.stringify({ version: 1, rules: [{ paths: ["**"], personas }] }, null, 2)}\n`;

/** A shell script that leaves `marker` behind when it runs. */
export const markerScript = (marker) => ({
  run: `#!/bin/sh\npwd > "${marker}"\necho marked\n`,
});

export async function waitForTurns(w, id, count, timeout = 30_000) {
  await w.poll(
    async () => {
      const [row] = await w.sql(
        "SELECT count(*)::int AS ended FROM agent_stream_events WHERE agent_id = $1 AND kind = 'turn' AND payload->>'endedAt' IS NOT NULL",
        [id]
      );
      return row.ended >= count;
    },
    `turn ${count} of ${id}`,
    timeout
  );
}

export async function turnCount(w, id) {
  const [row] = await w.sql(
    "SELECT count(*)::int AS total FROM agent_stream_events WHERE agent_id = $1 AND kind = 'turn'",
    [id]
  );
  return row.total;
}

export async function waitForTurnStart(w, id, before) {
  await w.poll(
    async () => (await turnCount(w, id)) > before,
    `a turn to start for ${id}`
  );
  // The fixture says "Waiting" before it sleeps, so it can now be cancelled.
  await sleep(500);
}

export async function prompt(w, id, text, extra = {}) {
  const before = await turnCount(w, id);
  const response = await w.api("POST", blocksPath(id), { text, ...extra });
  if (response.status >= 300) return response;
  await waitForTurns(w, id, before + 1);
  await w.quiet();
  return response;
}

export async function streamRows(w) {
  const rows = async (query) => (await w.sql(query)).map(({ row }) => row);
  return {
    blocks: await rows(
      "SELECT to_jsonb(b) AS row FROM blocks b ORDER BY created_at, id"
    ),
    events: await rows(
      "SELECT to_jsonb(e) AS row FROM agent_stream_events e ORDER BY id"
    ),
    files: await rows("SELECT to_jsonb(f) AS row FROM files f ORDER BY id"),
  };
}

/** A host's files. Contents are compared only where they are not process state. */
export function agentFiles(w, id) {
  const directory = join(w.paths.agents, id);
  if (!existsSync(directory)) return null;
  const read = (name) =>
    existsSync(join(directory, name))
      ? readFileSync(join(directory, name), "utf8")
      : null;
  const launch = JSON.parse(read("launch.json") ?? "null");
  if (launch?.mcp?.token) w.secrets.add(launch.mcp.token);
  const session = read("session.json");
  return {
    names: readdirSync(directory).sort(),
    launch,
    session: session && JSON.parse(session),
    journal: (read("journal.jsonl") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

export async function stop(w, id) {
  const response = await w.api("POST", agentPath(id, "/stop"), {});
  if (response.status < 300)
    await w.poll(async () => {
      const [row] = await w.sql("SELECT status FROM agents WHERE id = $1", [
        id,
      ]);
      return ["stopped", "error"].includes(row?.status);
    }, `${id} to stop`);
  await w.quiet();
  return response;
}

export async function startAgain(w, id) {
  const response = await w.api("POST", agentPath(id, "/start"), {});
  if (response.status < 300)
    await w.poll(async () => {
      const [row] = await w.sql("SELECT status FROM agents WHERE id = $1", [
        id,
      ]);
      return ["running", "error"].includes(row?.status);
    }, `${id} to start`);
  await w.quiet(1000);
  return response;
}

/** Archive, and what it came to. A refusal is an outcome, not a harness error. */
export async function archive(w, id, cleanup = "auto", extraQuery = "") {
  const response = await w.api(
    "DELETE",
    agentPath(id, `?cleanupWorktree=${cleanup}${extraQuery}`)
  );
  if (response.status < 300)
    await w.poll(
      async () => {
        const [row] = await w.sql(
          "SELECT status, deleted_at FROM agents WHERE id = $1",
          [id]
        );
        return !row || row.deleted_at || row.status !== "archiving";
      },
      `${id} to archive`,
      45_000
    );
  await w.quiet();
  const [row] = await w.sql(
    "SELECT status, last_error, deleted_at IS NOT NULL AS archived FROM agents WHERE id = $1",
    [id]
  );
  return { response, row: row ?? null };
}

export async function agentRow(w, id) {
  const [row] = await w.sql(
    "SELECT status, last_error, worktree_path, worktree_branch, base_branch, workspace_path FROM agents WHERE id = $1",
    [id]
  );
  return row ?? null;
}

/** Tool names only, where the schemas are not what the scenario is about. */
export async function toolNames(w, id) {
  const tools = await w.listTools(id);
  return tools.transportError || tools.answer
    ? tools
    : Object.fromEntries(Object.keys(tools).map((name) => [name, true]));
}

export async function postFile(w, id, path, extra = {}) {
  return w.call(id, "post", {
    text: "share",
    attachments: [{ type: "file", path, ...extra }],
  });
}

/** A branch off main with one committed change, as owner reviews need. */
export async function reviewableRepo(w, name, files) {
  const repo = await w.repo(name, files, { origin: true });
  await w.git(repo, ["switch", "--quiet", "-c", "feature"]);
  w.write(repo, { "changed.txt": "changed\n" });
  await w.git(repo, ["add", "changed.txt"]);
  await w.git(repo, ["commit", "--quiet", "-m", "Change"]);
  return repo;
}

export const ownerPlan = (w, id) =>
  w.call(id, "launch_owner_reviews", { context: "parity", dryRun: true });

/** The catalog route once its background refresh is over. */
export async function personaRoute(w, cwd) {
  const route = `/api/v1/personas?${new URLSearchParams({ cwd })}`;
  return w.poll(async () => {
    const reply = await w.api("GET", route);
    return reply.body?.refreshing !== true && reply;
  }, "the persona catalog to settle");
}
