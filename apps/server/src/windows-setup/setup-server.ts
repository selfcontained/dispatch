import nodeFs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { windowsSetupPageHtml } from "../generated/runtime-assets.js";
import { buildSetupEnv, writeEnvFile, type SetupEnv } from "./env-file.js";
import * as realPostgres from "./postgres.js";

const DEFAULT_POSTGRES = { host: "127.0.0.1", port: 5432 };

export type SetupDeps = {
  installDir: string;
  execPath: string;
  platform: NodeJS.Platform;
  version: string;
  fs?: Pick<typeof nodeFs, "copyFileSync">;
  postgres?: Pick<
    typeof realPostgres,
    "probeTcp" | "provisionDatabase" | "testConnection"
  >;
  isPortFree?: (port: number) => Promise<boolean>;
  fetchHealth?: (url: string) => Promise<boolean>;
};

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function fetchHealth(url: string): Promise<boolean> {
  const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  return response.ok;
}

function primaryLanIPv4(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function fail(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPort(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) > 0 &&
    (value as number) < 65536
  );
}

export function createSetupApp(deps: SetupDeps): {
  app: FastifyInstance;
  installed: Promise<SetupEnv>;
} {
  const fs = deps.fs ?? nodeFs;
  const postgres = deps.postgres ?? realPostgres;
  const portFree = deps.isPortFree ?? isPortFree;
  const health = deps.fetchHealth ?? fetchHealth;
  let databaseUrl: string | undefined;
  let resolveInstalled!: (env: SetupEnv) => void;
  const installed = new Promise<SetupEnv>((resolve) => {
    resolveInstalled = resolve;
  });

  const app = Fastify();

  app.get("/", (_request, reply) => reply.redirect("/setup", 302));

  app.get("/setup", (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(windowsSetupPageHtml)
  );

  app.get("/api/setup/state", async () => ({
    version: deps.version,
    installDir: deps.installDir,
    postgres: {
      ...DEFAULT_POSTGRES,
      reachable: await postgres.probeTcp(
        DEFAULT_POSTGRES.host,
        DEFAULT_POSTGRES.port
      ),
    },
  }));

  app.post("/api/setup/postgres/probe", async (request, reply) => {
    const body = request.body as { host?: unknown; port?: unknown };
    if (typeof body?.host !== "string" || !isPort(body.port))
      return fail(reply, 400, "Enter a host and a port.");
    return { reachable: await postgres.probeTcp(body.host, body.port) };
  });

  app.post("/api/setup/postgres/provision", async (request, reply) => {
    const body = request.body as {
      host?: unknown;
      port?: unknown;
      adminPassword?: unknown;
      connectionUrl?: unknown;
    };
    try {
      if (typeof body?.connectionUrl === "string") {
        if (!/^postgres(ql)?:\/\//.test(body.connectionUrl))
          return fail(reply, 400, "Enter a postgres:// connection URL.");
        await postgres.testConnection(body.connectionUrl);
        databaseUrl = body.connectionUrl;
      } else {
        if (
          typeof body?.host !== "string" ||
          !isPort(body.port) ||
          typeof body.adminPassword !== "string"
        )
          return fail(reply, 400, "Enter the postgres password.");
        const result = await postgres.provisionDatabase({
          adminUrl: realPostgres.adminUrl({
            host: body.host,
            port: body.port,
            password: body.adminPassword,
          }),
          host: body.host,
          port: body.port,
        });
        databaseUrl = result.databaseUrl;
      }
    } catch (error) {
      return fail(reply, 502, message(error));
    }
    return { masked: realPostgres.maskPassword(databaseUrl) };
  });

  app.post("/api/setup/install", async (request, reply) => {
    const body = request.body as { port?: unknown; listenOnLan?: unknown };
    if (!databaseUrl)
      return fail(reply, 400, "Connect to PostgreSQL before installing.");
    if (!isPort(body?.port)) return fail(reply, 400, "Enter a valid port.");
    if (!(await portFree(body.port)))
      return fail(
        reply,
        409,
        `Port ${body.port} is already in use. Choose another port.`
      );
    try {
      const target = path.join(deps.installDir, "dispatch.exe");
      if (
        deps.platform === "win32" &&
        path.dirname(deps.execPath) !== deps.installDir
      ) {
        nodeFs.mkdirSync(deps.installDir, { recursive: true });
        fs.copyFileSync(deps.execPath, target);
      }
      const env = buildSetupEnv({
        databaseUrl,
        port: body.port,
        listenHosts: body.listenOnLan === true ? primaryLanIPv4() : undefined,
        installDir: deps.installDir,
      });
      writeEnvFile(deps.installDir, env);
      resolveInstalled(env);
      return { url: `http://127.0.0.1:${body.port}` };
    } catch (error) {
      return fail(reply, 500, message(error));
    }
  });

  app.get("/api/setup/health", async (request) => {
    const port = Number((request.query as { port?: string }).port);
    if (!isPort(port)) return { ok: false };
    try {
      return { ok: await health(`http://127.0.0.1:${port}/api/v1/health`) };
    } catch {
      return { ok: false };
    }
  });

  return { app, installed };
}

export async function startSetupServer(deps: SetupDeps): Promise<{
  url: string;
  installed: Promise<SetupEnv>;
  close(): Promise<void>;
}> {
  const { app, installed } = createSetupApp(deps);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/setup`,
    installed,
    close: () => app.close(),
  };
}
