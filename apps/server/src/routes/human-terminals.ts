import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isPasswordSet, validateSession } from "../auth.js";
import { HumanTerminalManager, terminalOwner } from "../terminal/manager.js";

export function terminalOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  protocol: string,
  devStack = false
): boolean {
  if (!origin || !host) return false;
  try {
    const source = new URL(origin);
    if (source.origin !== origin || source.origin !== `${protocol}://${host}`)
      return false;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      source.hostname
    );
    return (
      source.protocol === "https:" ||
      (source.protocol === "http:" && (loopback || devStack))
    );
  } catch {
    return false;
  }
}

type Deps = {
  pool: Pool;
  sessionCookie: string;
  getAgent: (
    id: string
  ) => Promise<{ cwd: string; worktreePath: string | null } | null>;
  manager?: HumanTerminalManager;
};

export async function registerHumanTerminalRoutes(
  app: FastifyInstance,
  deps: Deps
) {
  const manager = deps.manager ?? new HumanTerminalManager();
  const owners = new WeakMap<
    FastifyRequest,
    { owner: string; token: string | null }
  >();
  await app.register(async (terminal) => {
    terminal.addHook("preHandler", async (request, reply) => {
      // Deliberately independent of the general API bearer and first-run hooks.
      if (
        !terminalOriginAllowed(
          request.headers.origin,
          request.headers.host,
          request.protocol,
          process.env.DISPATCH_DEV_STACK === "1"
        )
      ) {
        return reply.code(403).send({
          error:
            "Terminal requires a same-origin secure browser connection (HTTPS), or local loopback HTTP. Development previews may use HTTP.",
        });
      }
      const passwordSet = await isPasswordSet(deps.pool);
      // Dev previews normally have no login. Keep terminal ownership per browser
      // without issuing a general Dispatch login credential.
      if (process.env.DISPATCH_DEV_STACK === "1" && !passwordSet) {
        // Cookies share a host across ports; reuse the installation namespace.
        const cookieName = `${deps.sessionCookie}_terminal_dev`;
        const signedDev = request.cookies[cookieName];
        const unsignedDev = signedDev ? request.unsignCookie(signedDev) : null;
        let identity = unsignedDev?.valid ? unsignedDev.value : null;
        if (!identity) {
          if (
            request.method !== "POST" ||
            request.routeOptions.url !== "/api/v1/human-terminals"
          ) {
            return reply.code(401).send({ error: "Open a terminal first." });
          }
          identity = randomUUID();
          reply.setCookie(cookieName, identity, {
            path: "/api/v1/human-terminals",
            signed: true,
            httpOnly: true,
            sameSite: "strict",
            secure: request.protocol === "https",
          });
        }
        owners.set(request, {
          owner: terminalOwner(`dev:${identity}`),
          token: null,
        });
        return;
      }
      const signed = request.cookies[deps.sessionCookie];
      const unsigned = signed ? request.unsignCookie(signed) : null;
      if (
        !passwordSet ||
        !unsigned?.valid ||
        !unsigned.value ||
        !(await validateSession(deps.pool, unsigned.value))
      ) {
        return reply.code(401).send({
          code: passwordSet ? "session_required" : "password_not_set",
          error: passwordSet
            ? "Sign in with your Dispatch password to use the terminal."
            : "Set a Dispatch password to use the terminal.",
        });
      }
      owners.set(request, {
        owner: terminalOwner(unsigned.value),
        token: unsigned.value,
      });
    });
    terminal.post<{
      Body: { agentId: string; clientId: string; terminalId?: string };
    }>(
      "/api/v1/human-terminals",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["agentId", "clientId"],
            properties: {
              terminalId: { type: "string", maxLength: 100 },
              agentId: { type: "string", maxLength: 100 },
              clientId: { type: "string", pattern: "^[a-zA-Z0-9_-]{16,100}$" },
            },
          },
        },
      },
      async (request, reply) => {
        const owner = owners.get(request)!.owner;
        if (request.body.terminalId) {
          const resumed = manager.resume(
            request.body.terminalId,
            owner,
            request.body.clientId,
            request.body.agentId
          );
          if (!resumed)
            return reply.code(404).send({
              error:
                "Terminal expired or ended. Start a new terminal to continue.",
            });
          return { ...resumed, unencrypted: request.protocol !== "https" };
        }
        const agent = await deps.getAgent(request.body.agentId);
        if (!agent)
          return reply.code(404).send({ error: "Workspace not found." });
        try {
          const cwd = await realpath(agent.worktreePath || agent.cwd);
          if (!(await stat(cwd)).isDirectory())
            throw new Error("Workspace directory is unavailable.");
          return {
            ...manager.open(
              owners.get(request)!.owner,
              request.body.clientId,
              request.body.agentId,
              cwd
            ),
            unencrypted: request.protocol !== "https",
          };
        } catch (error) {
          return reply.code(409).send({
            error:
              error instanceof Error ? error.message : "Cannot open terminal.",
          });
        }
      }
    );
    terminal.delete<{ Params: { id: string } }>(
      "/api/v1/human-terminals/:id",
      async (request, reply) => {
        if (!manager.end(request.params.id, owners.get(request)!.owner))
          return reply.code(404).send({ error: "Terminal not found." });
        return { ok: true };
      }
    );
    terminal.get<{ Params: { id: string } }>(
      "/api/v1/human-terminals/:id/socket",
      { websocket: true },
      (socket, request) => {
        const { owner, token } = owners.get(request)!;
        if (!manager.attach(request.params.id, owner, socket)) {
          socket.close(1008, "Terminal not found.");
          return;
        }
        let alive = true;
        socket.on("pong", () => {
          alive = true;
        });
        const timer = setInterval(() => {
          if (!alive) {
            socket.terminate();
            return;
          }
          alive = false;
          socket.ping();
          const validSession =
            token === null
              ? isPasswordSet(deps.pool).then(
                  (set) => process.env.DISPATCH_DEV_STACK === "1" && !set
                )
              : validateSession(deps.pool, token);
          void validSession
            .then((valid) => {
              if (!valid) manager.end(request.params.id, owner);
            })
            .catch(() => manager.end(request.params.id, owner));
        }, 15_000);
        timer.unref();
        socket.on("close", () => clearInterval(timer));
      }
    );
  });
  // preClose runs before the websocket plugin waits for upgraded connections.
  app.addHook("preClose", async () => manager.shutdown());
}
