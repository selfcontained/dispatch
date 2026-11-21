import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import {
  createRunnerArtifactSource,
  describeRunnerArtifacts,
  openRunnerArtifact,
  resolveRunnerArtifact,
  RunnerPayloadUnavailable,
} from "../server/runner-artifacts.js";

declare module "fastify" {
  interface FastifyContextConfig {
    publicRunnerArtifact?: boolean;
  }
}

const PREFIX = "/api/v1/runner-artifacts";
const REVISION = /^[a-f0-9]{7,40}$/;

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
      const artifactRoute = resolveRunnerArtifact(name);
      if (
        !REVISION.test(requested) ||
        !artifactRoute ||
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
        const { arch, asset } = artifactRoute;
        const artifacts = await source.get(arch);
        if (!asset)
          return describeRunnerArtifacts(revision, version, artifacts, arch);
        const artifact = artifacts.files.find((file) => file.name === asset);
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
        if (err instanceof RunnerPayloadUnavailable)
          return reply.code(404).send({ error: err.message });
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
