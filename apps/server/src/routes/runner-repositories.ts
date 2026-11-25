import type { FastifyInstance } from "fastify";
import {
  validGitHubRepoPart,
  validRepositorySearch,
} from "@dispatch/runner-protocol";
import type { RemoteRunnerService } from "../agents/remote/service.js";

export function registerRunnerRepositorySearch(
  app: FastifyInstance,
  runners: Pick<
    RemoteRunnerService,
    | "searchGitHubRepositories"
    | "lookupGitHubPullRequestHead"
    | "listGitHubBranches"
  >
) {
  const options = { config: { validateSuppliedAuthorization: true } } as const;
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    "/api/v1/runners/:id/repository-search",
    options,
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const q = req.query.q;
      if (!validRepositorySearch(q))
        return reply
          .code(400)
          .send({ error: "Enter a repository name or owner/name." });
      try {
        return await runners.searchGitHubRepositories(req.params.id, q);
      } catch {
        return reply.code(503).send({
          error:
            "GitHub search is unavailable on this runner. Paste an HTTPS repository URL.",
        });
      }
    }
  );
  app.get<{ Params: { id: string; owner: string; repo: string } }>(
    "/api/v1/runners/:id/repositories/:owner/:repo/branches",
    options,
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const { id, owner, repo } = req.params;
      if (!validGitHubRepoPart(owner) || !validGitHubRepoPart(repo))
        return reply.code(400).send({ error: "Invalid repository." });
      try {
        return await runners.listGitHubBranches(id, owner, repo);
      } catch {
        return reply
          .code(503)
          .send({ error: "Couldn’t load branches from this runner." });
      }
    }
  );
  app.get<{ Params: { id: string }; Querystring: { url?: string } }>(
    "/api/v1/runners/:id/pull-request-head",
    options,
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const match =
        typeof req.query.url === "string" &&
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,9})\/?$/.exec(
          req.query.url
        );
      if (
        !match ||
        !validGitHubRepoPart(match[1]) ||
        !validGitHubRepoPart(match[2])
      )
        return reply
          .code(400)
          .send({ error: "Enter a GitHub pull request URL." });
      try {
        return await runners.lookupGitHubPullRequestHead(
          req.params.id,
          match[1],
          match[2],
          Number(match[3])
        );
      } catch {
        return reply.code(422).send({
          error:
            "Could not resolve the PR’s source branch. Check GitHub access on this runner or enter the source repository and branch.",
        });
      }
    }
  );
}
