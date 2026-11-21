import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import {
  createRunnerArtifactSource,
  describeRunnerArtifacts,
  openRunnerArtifact,
  RUNNER_ARTIFACT_FILES,
} from "../server/runner-artifacts.js";

declare module "fastify" {
  interface FastifyContextConfig {
    publicRunnerArtifact?: boolean;
  }
}

const PREFIX = "/api/v1/runner-artifacts";
const DESCRIPTOR = "descriptor.json";
const REVISION = /^[a-f0-9]{7,40}$/;
const FILE_NAMES = new Set<string>(RUNNER_ARTIFACT_FILES);

export function registerRunnerArtifacts(
  app: FastifyInstance,
  build: { revision: string | null; version: string; compiled: boolean },
  now?: () => number
) {
  const { revision, version } = build;
  const source = createRunnerArtifactSource(
    {
      ...build,
      revision: revision ?? "",
    },
    now
  );
  app.get<{ Params: { revision: string; file: string } }>(
    `${PREFIX}/:revision/:file`,
    { config: { publicRunnerArtifact: true } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const { revision: requested, file: name } = request.params;
      if (
        !REVISION.test(requested) ||
        (name !== DESCRIPTOR && !FILE_NAMES.has(name)) ||
        request.url.split("?")[0] !== `${PREFIX}/${requested}/${name}`
      )
        return reply.code(404).send({ error: "Invalid runner artifact path." });
      if (!revision || requested !== revision)
        return reply.code(404).send({
          error:
            "Runner artifacts are available only for this controller's running revision.",
        });
      if (!source.enabled)
        return reply.code(404).send({
          error: "Runner artifacts are disabled for this build.",
        });

      try {
        const artifacts = await source.get();
        if (name === DESCRIPTOR)
          return describeRunnerArtifacts(revision, version, artifacts);
        const artifact = artifacts.files.find((file) => file.name === name);
        if (!artifact)
          return reply
            .code(404)
            .send({ error: "Runner artifact is unavailable for this build." });
        const handle = await openRunnerArtifact(artifact);
        reply
          .type(
            name.endsWith(".json")
              ? "application/json"
              : name.endsWith(".gz")
                ? "application/gzip"
                : "application/octet-stream"
          )
          .header("Content-Disposition", `attachment; filename="${name}"`)
          .header("Content-Length", artifact.stat.size)
          .header(
            "Repr-Digest",
            `sha-256=:${Buffer.from(artifact.sha256, "hex").toString("base64")}:`
          )
          .header("X-Content-Type-Options", "nosniff");
        if (request.method === "HEAD") {
          await handle.close();
          // Fastify's automatic HEAD hook preserves a stream's declared length.
          return reply.send(Readable.from([]));
        }
        return reply.send(handle.createReadStream());
      } catch (err) {
        request.log.error({ err }, "Could not prepare runner artifacts");
        return reply.code(503).send({
          error:
            "Runner artifacts could not be prepared or verified. Check the controller logs.",
        });
      }
    }
  );
  return source;
}
