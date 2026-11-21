import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  resolveRunnerUpdatePath,
  RUNNER_UPDATE_PREFIX,
} from "../agents/remote/update-artifact-path.js";
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

const PREFIX = RUNNER_UPDATE_PREFIX;
const REVISION = /^[a-f0-9]{7,40}$/;

async function streamArtifact(
  reply: FastifyReply,
  artifact: Parameters<typeof openRunnerArtifact>[0] & { sha256: string },
  name: string,
  method: string
) {
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
  if (method === "HEAD") {
    await handle.close();
    // Fastify's automatic HEAD hook preserves a stream's declared length.
    return reply.send(Readable.from([]));
  }
  return reply.send(handle.createReadStream());
}

/**
 * The executable compresses to about a third of its size. The updater checks
 * the signed digest of the decompressed bytes, so the encoding adds no trust.
 */
async function streamCompressed(
  reply: FastifyReply,
  artifact: Parameters<typeof openRunnerArtifact>[0],
  method: string
) {
  const handle = await openRunnerArtifact(artifact);
  reply
    .type("application/gzip")
    .header("Content-Disposition", 'attachment; filename="dispatch-runner.gz"')
    .header("X-Content-Type-Options", "nosniff");
  if (method === "HEAD") {
    await handle.close();
    return reply.send(Readable.from([]));
  }
  return reply.send(handle.createReadStream().pipe(createGzip()));
}

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
        return await streamArtifact(reply, artifact, name, request.method);
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
  const serveUpdate = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    const update = resolveRunnerUpdatePath(request.url);
    if (
      !update ||
      (update.revision !== undefined && update.revision !== revision) ||
      update.version !== version
    )
      return reply.code(404).send({
        error: "Invalid runner update path for this controller build.",
      });

    try {
      const { manifest, envelope, executable } = await source.getUpdate(
        update.arch
      );
      if (manifest.sha256 !== update.sha256)
        return reply
          .code(404)
          .send({ error: "Runner update digest is unavailable." });
      if (update.file === "manifest.json") {
        return reply
          .type("application/json")
          .header("Content-Length", envelope.bytes.length)
          .header("X-Content-Type-Options", "nosniff")
          .send(envelope.bytes);
      }
      if (update.file === "dispatch-runner.gz")
        return await streamCompressed(reply, executable, request.method);
      return await streamArtifact(
        reply,
        executable,
        update.file,
        request.method
      );
    } catch (err) {
      if (err instanceof RunnerPayloadUnavailable)
        return reply.code(404).send({ error: err.message });
      request.log.error({ err }, "Could not prepare runner update");
      return reply.code(503).send({
        error:
          "Runner update could not be prepared or verified. Check the controller logs.",
      });
    }
  };
  const route = { config: { publicRunnerArtifact: true } };
  app.get(
    `${PREFIX}/:revision/update/:version/linux/:arch/:sha256/:file`,
    route,
    serveUpdate
  );
  app.get(
    `${PREFIX}/update/:version/linux/:arch/:sha256/:file`,
    route,
    serveUpdate
  );
  return source;
}
