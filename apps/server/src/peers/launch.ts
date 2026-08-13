import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import type { AgentType } from "../agents/types.js";
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../agent-type-settings.js";
import { validateAgentModel } from "../shared/agent-models.js";
import { getWorktreeLocation } from "../worktree-location-settings.js";
import { getOrCreateInstanceId } from "./identity.js";

/**
 * Everything a remote launch needs is explicit in this payload — the usual
 * parent-derived defaults (type, cwd, fullAccess) cannot cross instances
 * because the parent lives on the other machine.
 */
export type PeerLaunchPayload = {
  name: string;
  prompt: string;
  type: string;
  model?: string;
  cwd: string;
  fullAccess?: boolean;
  useWorktree?: boolean;
  createNewBranch?: boolean;
  baseBranch?: string;
  worktreeBranch?: string;
  /** Qualified address of the launching agent: "<instanceId>:<agentId>". */
  parentAddress: string;
};

export type PeerLaunchResult = {
  agentId: string;
  name: string;
  status: string;
};

function buildRemoteChildInitialPrompt(
  parentAddress: string,
  prompt: string
): string {
  return [
    `You were launched from a linked Dispatch instance by agent "${parentAddress}" via dispatch_launch_agent.`,
    "Use that full address (instance:agent) as the target when coordinating back with dispatch_send_message.",
    "",
    prompt,
  ].join("\n");
}

/**
 * Receiver side of POST /api/v1/peers/launch: run the launch through this
 * instance's own createAgent, exactly like a local launch. Nothing here is
 * peer-special beyond the qualified parent address in the child's preamble.
 */
export async function handleIncomingPeerLaunch(
  deps: { pool: Pool; agentManager: AgentManager },
  payload: PeerLaunchPayload
): Promise<PeerLaunchResult> {
  const agentType = payload.type;
  if (
    !CLI_AGENT_TYPES.includes(agentType as (typeof CLI_AGENT_TYPES)[number])
  ) {
    throw new Error(
      `Unsupported agent type "${agentType}". Must be one of: ${CLI_AGENT_TYPES.join(", ")}.`
    );
  }
  const enabled = await getEnabledAgentTypes(deps.pool);
  if (!enabled.includes(agentType as (typeof CLI_AGENT_TYPES)[number])) {
    throw new Error(`${agentType} agents are disabled on this instance.`);
  }
  const model = validateAgentModel(
    agentType as (typeof CLI_AGENT_TYPES)[number],
    payload.model
  );
  const worktreeLocation = await getWorktreeLocation(deps.pool);
  const cliSessionId = agentType === "claude" ? randomUUID() : undefined;

  const agent = await deps.agentManager.createAgent({
    cliSessionId,
    name: payload.name,
    type: agentType as AgentType,
    cwd: payload.cwd,
    fullAccess: payload.fullAccess ?? false,
    model,
    useWorktree: payload.useWorktree ?? false,
    createNewBranch: payload.createNewBranch ?? false,
    baseBranch: payload.baseBranch,
    worktreeBranch: payload.worktreeBranch,
    worktreeLocation,
    initialPrompt: buildRemoteChildInitialPrompt(
      payload.parentAddress,
      payload.prompt
    ),
  });
  return { agentId: agent.id, name: agent.name, status: agent.status };
}

export type PeerRepo = { root: string; name: string };

/**
 * The repos this instance can launch into: distinct repo roots its agents
 * have worked in. "The environment already exists" is a design assumption —
 * remote provisioning is out of scope.
 */
export async function listLocalRepos(pool: Pool): Promise<PeerRepo[]> {
  const result = await pool.query<{ root: string }>(
    `SELECT DISTINCT COALESCE(git_context->>'repoRoot', cwd) AS root
       FROM agents
      WHERE deleted_at IS NULL AND peer_id IS NULL
      ORDER BY root`
  );
  return result.rows.map((row) => ({
    root: row.root,
    name: row.root.split("/").filter(Boolean).at(-1) ?? row.root,
  }));
}

export type ResolvedPeer = {
  id: string;
  name: string;
  url: string;
  outboundToken: string;
};

/** Look up a linked peer by display name or instance id. */
export async function resolvePeerLocation(
  pool: Pool,
  location: string
): Promise<{ ok: true; peer: ResolvedPeer } | { ok: false; error: string }> {
  const peers = await pool.query<{
    id: string;
    name: string;
    url: string;
    outbound_token: string;
  }>(
    `SELECT id, name, url, outbound_token FROM peers WHERE revoked_at IS NULL`
  );
  const matches = peers.rows.filter(
    (p) => p.id === location || p.name === location
  );
  if (matches.length === 0) {
    const known = peers.rows.map((p) => p.name).join(", ") || "none";
    return {
      ok: false,
      error: `Unknown location "${location}". Linked instances: ${known}.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `Location "${location}" is ambiguous — use the instance id instead (${matches.map((p) => p.id).join(", ")}).`,
    };
  }
  const peer = matches[0];
  return {
    ok: true,
    peer: {
      id: peer.id,
      name: peer.name,
      url: peer.url,
      outboundToken: peer.outbound_token,
    },
  };
}

async function peerFetch(
  peer: ResolvedPeer,
  path: string,
  init: RequestInit | undefined,
  fetchImpl: typeof fetch
): Promise<Response> {
  return await fetchImpl(`${peer.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${peer.outboundToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

export async function fetchPeerRepos(
  peer: ResolvedPeer,
  fetchImpl: typeof fetch = fetch
): Promise<PeerRepo[]> {
  const response = await peerFetch(peer, "/api/v1/peers/repos", {}, fetchImpl);
  if (!response.ok) {
    throw new Error(
      `Peer "${peer.name}" repo listing failed (${response.status}).`
    );
  }
  const body = (await response.json()) as { repos?: PeerRepo[] };
  return body.repos ?? [];
}

/**
 * Sender side: POST the launch to the peer, then mint the local shadow row
 * pointing at the remote agent so the rest of Dispatch needs no changes.
 */
export async function launchAgentOnPeer(
  deps: {
    pool: Pool;
    agentManager: AgentManager;
    fetchImpl?: typeof fetch;
  },
  peer: ResolvedPeer,
  input: {
    name: string;
    prompt: string;
    type: string;
    model?: string;
    cwd: string;
    fullAccess?: boolean;
    parentAgentId: string;
  }
): Promise<{ shadowAgentId: string; remoteAgentId: string; name: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const instanceId = await getOrCreateInstanceId(deps.pool);
  const payload: PeerLaunchPayload = {
    name: input.name,
    prompt: input.prompt,
    type: input.type,
    model: input.model,
    cwd: input.cwd,
    fullAccess: input.fullAccess,
    parentAddress: `${instanceId}:${input.parentAgentId}`,
  };
  let response: Response;
  try {
    response = await peerFetch(
      peer,
      "/api/v1/peers/launch",
      { method: "POST", body: JSON.stringify(payload) },
      fetchImpl
    );
  } catch {
    throw new Error(
      `Could not reach linked instance "${peer.name}" at ${peer.url}.`
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Launch on "${peer.name}" failed (${response.status}).`
    );
  }
  const result = (await response.json()) as PeerLaunchResult;

  const shadow = await deps.agentManager.createShadowAgent({
    peerId: peer.id,
    remoteId: result.agentId,
    name: result.name,
    type: input.type as AgentType,
    cwd: input.cwd,
    status: "creating",
    parentAgentId: input.parentAgentId,
  });
  return {
    shadowAgentId: shadow.id,
    remoteAgentId: result.agentId,
    name: result.name,
  };
}
