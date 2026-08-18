import os from "node:os";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import * as z from "zod/v4";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import { getSetting } from "../db/settings.js";
import { handleIncomingPeerLaunch, listLocalRepos } from "../peers/launch.js";
import { receivePeerMessage } from "../peers/messages.js";
import { requirePeerAuth } from "../peers/peer-auth.js";
import {
  claimPairing,
  createPairingOffer,
  linkToPeer,
  listPeers,
  PEER_PROTOCOL_VERSION,
  renamePeer,
  revokePeer,
} from "../peers/pairing.js";
import { setTailnetBindEnabled } from "../peers/peer-settings.js";
import type { PeerRuntime } from "../peers/runtime.js";
import { parseInput } from "../shared/lib/parse-input.js";

const TailnetBindBodySchema = z.object({
  enabled: z.boolean(),
});

const PairingOfferBodySchema = z.object({
  allowLaunch: z.boolean().default(true),
  allowMessage: z.boolean().default(true),
  allowFullAccess: z.boolean().default(false),
  allowEvents: z.boolean().default(true),
  requireTailnet: z.boolean().default(true),
});

const PeerRenameBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const ClaimBodySchema = z.object({
  protocolVersion: z.number().int().optional(),
  code: z.string().trim().min(6).max(12),
  instance: z.object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(120),
    url: z.string().trim().min(1).max(4_096),
    token: z.string().min(32).max(256),
  }),
});

const LinkBodySchema = z.object({
  address: z.string().trim().min(1).max(4_096),
  code: z.string().trim().min(6).max(12),
  name: z.string().trim().min(1).max(120).optional(),
  allowLaunch: z.boolean().default(true),
  allowMessage: z.boolean().default(true),
  allowFullAccess: z.boolean().default(false),
  allowEvents: z.boolean().default(true),
  selfUrl: z.string().trim().max(4_096).optional(),
});

const PeerParamsSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

const PeerMessageBodySchema = z.object({
  targetAgentId: z.string().trim().min(1).max(128),
  prompt: z.string().min(1).max(200_000),
  idempotencyKey: z.uuid(),
});

const PeerLaunchBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  prompt: z.string().min(1).max(100_000),
  type: z.string().trim().min(1).max(32),
  model: z.string().trim().max(200).optional(),
  cwd: z.string().trim().min(1).max(4_096),
  fullAccess: z.boolean().optional(),
  useWorktree: z.boolean().optional(),
  createNewBranch: z.boolean().optional(),
  baseBranch: z.string().trim().max(500).optional(),
  worktreeBranch: z.string().trim().max(500).optional(),
  parentAddress: z.string().trim().min(1).max(200),
});

type PeerRouteDeps = {
  pool: Pool;
  peerRuntime: PeerRuntime;
  isPasswordSet: () => Promise<boolean>;
  port: number;
  agentManager: AgentManager;
  publishUiEvent: (event: { type: string; agent?: unknown }) => void;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  injectAgentPrompt: (
    agentId: string,
    prompt: string,
    opts: { swallowFailure: boolean; awaitDelivery: boolean }
  ) => Promise<void>;
  subscribeUiEvents: (stream: NodeJS.WritableStream) => () => void;
};

async function instanceDisplayName(pool: Pool): Promise<string> {
  const configured = await getSetting(pool, "instance_name");
  return configured && configured.length > 0 ? configured : os.hostname();
}

export async function registerPeerRoutes(
  app: FastifyInstance,
  deps: PeerRouteDeps
): Promise<void> {
  app.get("/api/v1/peers/self", async () => {
    const [status, name] = await Promise.all([
      deps.peerRuntime.selfStatus(),
      instanceDisplayName(deps.pool),
    ]);
    // The name a peer will adopt as its local label when it pairs with us, so
    // the pairing card can show what the other side is about to see.
    return { ...status, name };
  });

  app.post("/api/v1/peers/settings/tailnet-bind", async (request, reply) => {
    const input = parseInput(TailnetBindBodySchema, request.body, reply);
    if (!input) return;

    if (input.enabled) {
      const status = await deps.peerRuntime.selfStatus();
      if (!status.passwordSet) {
        return reply.code(409).send({
          error:
            "Set a password before exposing this instance on the tailnet — without one, every route is open.",
        });
      }
      if (!status.tailscale) {
        return reply.code(409).send({
          error: "Tailscale is not running on this machine.",
        });
      }
    }

    await setTailnetBindEnabled(deps.pool, input.enabled);
    const bind = await deps.peerRuntime.applyTailnetBind();
    return { bind };
  });

  app.get("/api/v1/peers", async () => {
    return { peers: await listPeers(deps.pool) };
  });

  // Acceptor: mint an offer whose code renders in THIS instance's UI.
  app.post("/api/v1/peers/pairings", async (request, reply) => {
    const input = parseInput(PairingOfferBodySchema, request.body, reply);
    if (!input) return;
    if (!(await deps.isPasswordSet())) {
      return reply.code(409).send({
        error: "Set a password before pairing with another instance.",
      });
    }
    const offer = await createPairingOffer(deps.pool, input);
    const status = await deps.peerRuntime.selfStatus();
    return {
      ...offer,
      // What the human carries to the other machine, alongside the code.
      address: status.tailscale
        ? `${status.tailscale.dnsName}:${deps.port}`
        : null,
      tailnetBindActive: status.bind.active,
    };
  });

  // Acceptor: an instance the user typed our code into calls this. Open route
  // (the caller has no credential yet) — code + rate limit + whois gate it.
  app.post(
    "/api/v1/auth/peers/claim",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = parseInput(ClaimBodySchema, request.body, reply);
      if (!input) return;
      if (input.protocolVersion !== PEER_PROTOCOL_VERSION) {
        return reply.code(409).send({
          error: `This instance speaks peer protocol v${PEER_PROTOCOL_VERSION}; the claiming instance sent v${input.protocolVersion ?? "unknown"}. Update the older instance and pair again.`,
        });
      }
      if (!(await deps.isPasswordSet())) {
        return reply
          .code(409)
          .send({ error: "This instance has no password set." });
      }
      const remote = request.socket.remoteAddress;
      const callerAddr = remote
        ? `${remote.startsWith("::ffff:") ? remote.slice(7) : remote}:${request.socket.remotePort ?? 0}`
        : null;
      const result = await claimPairing(
        deps.pool,
        {
          code: input.code,
          claimer: {
            instanceId: input.instance.id,
            name: input.instance.name,
            url: input.instance.url,
            token: input.instance.token,
          },
          callerAddr,
        },
        await instanceDisplayName(deps.pool)
      );
      if (!result.ok) {
        return reply.code(result.status).send({ error: result.error });
      }
      return {
        protocolVersion: PEER_PROTOCOL_VERSION,
        instanceId: result.instanceId,
        name: result.name,
        token: result.token,
      };
    }
  );

  // Claimer: the user typed a code shown on another instance — dial it.
  app.post("/api/v1/peers/link", async (request, reply) => {
    const input = parseInput(LinkBodySchema, request.body, reply);
    if (!input) return;
    if (!(await deps.isPasswordSet())) {
      return reply.code(409).send({
        error: "Set a password before pairing with another instance.",
      });
    }
    const result = await linkToPeer(deps.pool, input, {
      instanceName: await instanceDisplayName(deps.pool),
      port: deps.port,
    });
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }
    return { peer: result.peer };
  });

  // Called BY a linked peer. Runs this instance's own createAgent — nothing
  // about the remote path is special on the receiving side.
  app.post(
    "/api/v1/peers/launch",
    {
      config: {
        peerBearer: true,
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      preHandler: (request, reply) =>
        requirePeerAuth(deps.pool, request, reply),
    },
    async (request, reply) => {
      const input = parseInput(PeerLaunchBodySchema, request.body, reply);
      if (!input) return;
      if (!request.peerAuth!.allowLaunch) {
        return reply.code(403).send({
          error:
            "This peer is not allowed to launch agents here (pair-time policy).",
        });
      }
      try {
        const result = await handleIncomingPeerLaunch(
          { pool: deps.pool, agentManager: deps.agentManager },
          input,
          { allowFullAccess: request.peerAuth!.allowFullAccess }
        );
        const agent = await deps.agentManager.getAgent(result.agentId);
        if (agent) {
          deps.publishUiEvent({
            type: "agent.upsert",
            agent: deps.withStreamFlag(agent),
          });
        }
        return result;
      } catch (error) {
        return reply.code(422).send({
          error: error instanceof Error ? error.message : "Launch failed.",
        });
      }
    }
  );

  // Called BY a linked peer. Deduped on idempotency key, then injected via
  // this instance's own prompt path — the quiet gate and all.
  app.post(
    "/api/v1/peers/messages",
    {
      config: {
        peerBearer: true,
        rateLimit: { max: 120, timeWindow: "1 minute" },
      },
      preHandler: (request, reply) =>
        requirePeerAuth(deps.pool, request, reply),
    },
    async (request, reply) => {
      const input = parseInput(PeerMessageBodySchema, request.body, reply);
      if (!input) return;
      // Messaging is its own capability. Injecting a prompt into a full-access
      // agent is code execution by a slower route, so a peer told it may not
      // launch here must not reach agents here either.
      if (!request.peerAuth!.allowMessage) {
        return reply.code(403).send({
          error:
            "This peer is not allowed to message agents here (pair-time policy).",
        });
      }
      const result = await receivePeerMessage(
        { pool: deps.pool, injectAgentPrompt: deps.injectAgentPrompt },
        request.peerAuth!.peerId,
        input
      );
      if (result.status === "failed") {
        return reply.code(502).send({ error: result.error });
      }
      return { status: result.status };
    }
  );

  // Called BY a linked peer: the event stream it mirrors shadow rows from.
  // Same mechanics as /api/v1/events — snapshot on connect, then live events.
  app.get(
    "/api/v1/peers/events",
    {
      config: { peerBearer: true },
      preHandler: (request, reply) =>
        requirePeerAuth(deps.pool, request, reply),
    },
    async (request, reply) => {
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.hijack();

      const stream = reply.raw;
      // Peers get a scoped view, not the full UI event firehose: only
      // agent.upsert, only local (non-shadow) agents, only the fields the
      // mirror consumes. Live events buffer until the snapshot is written so a
      // reconnect can never regress a shadow with an older snapshot.
      //
      // latestEvent is its own capability: identity and status are what a
      // shadow row needs to exist at all, but the event text is whatever the
      // agent wrote about itself, and that says far more about this machine.
      // Omitted entirely (not nulled) when ungranted, so the mirror can tell
      // "not shared" from "no event yet" and leave the shadow's own state be.
      const shareEvents = request.peerAuth!.allowEvents;
      const slim = (agent: {
        id: string;
        name: string;
        type: string;
        status: string;
        latestEvent?: AgentRecord["latestEvent"];
      }) => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
        ...(shareEvents ? { latestEvent: agent.latestEvent ?? null } : {}),
      });
      let snapshotSent = false;
      const pending: string[] = [];
      const filtered = {
        write(chunk: unknown): boolean {
          const dataLine = String(chunk)
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!dataLine) return true;
          try {
            const event = JSON.parse(dataLine.slice(6)) as {
              type?: string;
              agent?: AgentRecord;
            };
            if (event.type !== "agent.upsert" || !event.agent) return true;
            if (event.agent.peerId) return true;
            const payload = `data: ${JSON.stringify({ type: "agent.upsert", agent: slim(event.agent) })}\n\n`;
            if (snapshotSent) stream.write(payload);
            else pending.push(payload);
          } catch {
            // Malformed frame — never a peer's problem.
          }
          return true;
        },
      } as unknown as NodeJS.WritableStream;
      const unsubscribe = deps.subscribeUiEvents(filtered);
      const heartbeat = setInterval(() => {
        stream.write(": keepalive\n\n");
      }, 20_000);
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.raw.once("close", cleanup);
      request.raw.once("aborted", cleanup);
      if (request.raw.destroyed) {
        cleanup();
        return;
      }
      try {
        const agents = await deps.agentManager.listAgents();
        if (request.raw.destroyed) {
          cleanup();
          return;
        }
        stream.write(
          `data: ${JSON.stringify({
            type: "snapshot",
            agents: agents.filter((agent) => !agent.peerId).map(slim),
          })}\n\n`
        );
        snapshotSent = true;
        for (const payload of pending) stream.write(payload);
        pending.length = 0;
      } catch {
        // Without a snapshot, buffered delivery would hold events forever —
        // drop the connection so the peer reconnects and re-snapshots.
        cleanup();
        stream.destroy();
      }
    }
  );

  // Called BY a linked peer to populate its location/repo picker.
  app.get(
    "/api/v1/peers/repos",
    {
      config: { peerBearer: true },
      preHandler: (request, reply) =>
        requirePeerAuth(deps.pool, request, reply),
    },
    async () => {
      return { repos: await listLocalRepos(deps.pool) };
    }
  );

  // Rename a linked instance locally. "Cloud" is a statement about where the
  // peer sits relative to THIS machine, so the remote is never told — and the
  // label is what agents pass as `location`.
  app.patch("/api/v1/peers/:id", async (request, reply) => {
    const params = parseInput(PeerParamsSchema, request.params, reply);
    if (!params) return;
    const body = parseInput(PeerRenameBodySchema, request.body, reply);
    if (!body) return;
    const result = await renamePeer(deps.pool, params.id, body.name);
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error });
    }
    return { peer: { id: params.id, name: result.name } };
  });

  app.delete("/api/v1/peers/:id", async (request, reply) => {
    const params = parseInput(PeerParamsSchema, request.params, reply);
    if (!params) return;
    const revoked = await revokePeer(deps.pool, params.id);
    if (!revoked) {
      return reply.code(404).send({ error: "Peer not found." });
    }
    return { ok: true };
  });
}
