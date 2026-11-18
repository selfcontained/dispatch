import type { FastifyInstance } from "fastify";
import { runCommand, type CommandRunner } from "../shared/lib/run-command.js";

/** Search with the service user's gh account. Only the repository address leaves the service. */
export function registerRunnerRepositorySearch(
  app: FastifyInstance,
  run: CommandRunner = runCommand
) {
  app.get<{ Querystring: { q?: string } }>(
    "/api/v1/runners/repository-search",
    async (req, reply) => {
      const q = req.query.q;
      if (
        typeof q !== "string" ||
        !/^[a-zA-Z0-9_.-][a-zA-Z0-9_./ -]{1,99}$/.test(q)
      )
        return reply
          .code(400)
          .send({ error: "Enter a repository name or owner/name." });
      try {
        const { stdout } = await run(
          "gh",
          [
            "search",
            "repos",
            "--match",
            "name",
            "--limit",
            "12",
            "--json",
            "fullName,url",
            "--",
            q,
          ],
          {
            timeoutMs: 8000,
            env: { GH_PROMPT_DISABLED: "1" },
          }
        );
        const rows: unknown = JSON.parse(stdout);
        if (!Array.isArray(rows)) throw new Error("Invalid repository list");
        const repositories = rows.flatMap((row) =>
          typeof row?.fullName === "string" &&
          typeof row.url === "string" &&
          /^https:\/\//.test(row.url)
            ? [{ name: row.fullName, url: row.url }]
            : []
        );
        return { repositories };
      } catch {
        return reply.code(503).send({
          error: "GitHub search is unavailable. Paste an HTTPS repository URL.",
        });
      }
    }
  );
  app.get<{ Querystring: { url?: string } }>(
    "/api/v1/runners/pull-request-head",
    async (req, reply) => {
      const match =
        typeof req.query.url === "string" &&
        /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/pull\/([1-9][0-9]{0,9})\/?$/.exec(
          req.query.url
        );
      if (!match || [match[1], match[2]].some((v) => v === "." || v === ".."))
        return reply
          .code(400)
          .send({ error: "Enter a GitHub pull request URL." });
      try {
        // The pull ref in the base repo is read-only. Resolve the actual contributor branch.
        const { stdout } = await run(
          "gh",
          [
            "api",
            "--hostname",
            "github.com",
            `repos/${match[1]}/${match[2]}/pulls/${match[3]}`,
            "--jq",
            "{url:.head.repo.clone_url,branch:.head.ref}",
          ],
          { timeoutMs: 8000, env: { GH_PROMPT_DISABLED: "1" } }
        );
        const head: unknown = JSON.parse(stdout);
        if (
          !head ||
          typeof head !== "object" ||
          !("url" in head) ||
          !("branch" in head) ||
          typeof head.branch !== "string" ||
          !head.branch ||
          typeof head.url !== "string" ||
          !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/.test(
            head.url
          )
        )
          throw new Error("Unavailable head");
        return { url: head.url, branch: head.branch };
      } catch {
        return reply.code(422).send({
          error:
            "Could not resolve the PR’s source branch. Check GitHub access or enter the source repository and branch.",
        });
      }
    }
  );
}
