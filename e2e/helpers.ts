import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { type Page, type APIRequestContext } from "@playwright/test";

const API = "/api/v1";
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "dev-token";

const trackedAgentIds = new Set<string>();

/**
 * Click an agent row to attach/focus it. Clicks the icon area (left edge)
 * to avoid hitting the session name button which opens the settings dialog.
 */
export async function clickAgentRow(
  page: Page,
  agentId: string
): Promise<void> {
  await page
    .getByTestId(`agent-row-${agentId}`)
    .click({ position: { x: 4, y: 8 } });
}

/** Register an agent ID for cleanup — use when creating agents outside createAgentViaAPI. */
export function trackAgent(id: string): void {
  trackedAgentIds.add(id);
}

/** Return Authorization header for API requests. */
function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${AUTH_TOKEN}` };
}

type AgentResult = {
  id: string;
  name: string;
  status: string;
  cwd: string;
  worktreePath: string | null;
  worktreeBranch: string | null;
};

type AgentPinRecord = {
  label: string;
  value: string;
  type: "string" | "url" | "port" | "code" | "pr" | "filename" | "markdown";
};

/**
 * Create an agent via the REST API (faster than going through the UI every time).
 * When useWorktree is true, polls until the setup script completes (status transitions
 * from 'creating' to 'running') so the worktree fields are populated.
 */
export async function createAgentViaAPI(
  request: APIRequestContext,
  overrides: {
    name?: string;
    type?: string;
    cwd?: string;
    useWorktree?: boolean;
    worktreeBranch?: string;
  } = {}
): Promise<AgentResult> {
  const res = await request.post(`${API}/agents`, {
    headers: authHeaders(),
    data: {
      name: overrides.name ?? `e2e-agent-${Date.now()}`,
      type: overrides.type ?? "codex",
      cwd: overrides.cwd ?? "/tmp",
      useWorktree: overrides.useWorktree ?? false,
      worktreeBranch: overrides.worktreeBranch,
    },
  });
  const body = (await res.json()) as { agent: AgentResult };
  let agent = body.agent;
  trackedAgentIds.add(agent.id);

  // When using worktrees, the setup runs asynchronously in tmux.
  // Poll until the agent transitions to 'running' (setup complete).
  if (overrides.useWorktree && agent.status === "creating") {
    const deadline = Date.now() + 60_000;
    while (agent.status === "creating" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = await request.get(`${API}/agents/${agent.id}`, {
        headers: authHeaders(),
      });
      const pollBody = (await poll.json()) as { agent: AgentResult };
      agent = pollBody.agent;
    }
    if (agent.status === "creating") {
      throw new Error(`Agent ${agent.id} setup did not complete within 60s`);
    }
  }

  return agent;
}

export async function getWorktreeStatusViaAPI(
  request: APIRequestContext,
  agentId: string
): Promise<{
  hasWorktree: boolean;
  hasUnmergedCommits: boolean;
  worktreePath: string | null;
  branchName: string | null;
  changedFiles: string[];
}> {
  const res = await request.get(`${API}/agents/${agentId}/worktree-status`, {
    headers: authHeaders(),
  });
  return (await res.json()) as {
    hasWorktree: boolean;
    hasUnmergedCommits: boolean;
    worktreePath: string | null;
    branchName: string | null;
    changedFiles: string[];
  };
}

export async function setAgentLatestEventViaAPI(
  request: APIRequestContext,
  agentId: string,
  event: {
    type: "working" | "blocked" | "waiting_user" | "done" | "idle";
    message: string;
  }
): Promise<void> {
  await request.post(`${API}/agents/${agentId}/latest-event`, {
    headers: authHeaders(),
    data: event,
  });
}

export async function setEnabledAgentTypesViaAPI(
  request: APIRequestContext,
  enabledAgentTypes: string[]
): Promise<void> {
  const res = await request.post(`${API}/app/settings/agent-types`, {
    headers: authHeaders(),
    data: { enabledAgentTypes },
  });

  if (!res.ok()) {
    throw new Error(`Failed to update agent type settings: ${res.status()}`);
  }
}

export async function uploadMediaViaAPI(
  request: APIRequestContext,
  agentId: string,
  description: string,
  fileName = `media-${Date.now()}.png`
): Promise<void> {
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9VE3D7wAAAAASUVORK5CYII=",
    "base64"
  );

  const res = await request.post(`${API}/agents/${agentId}/media`, {
    headers: authHeaders(),
    multipart: {
      description,
      source: "screenshot",
      file: {
        name: fileName,
        mimeType: "image/png",
        buffer: pngBytes,
      },
    },
  });

  if (!res.ok()) {
    throw new Error(`Media upload failed with ${res.status()}`);
  }
}

export async function uploadTextMediaViaAPI(
  request: APIRequestContext,
  agentId: string,
  description: string,
  content: string,
  fileName = `media-${Date.now()}.md`,
  mimeType = "text/markdown"
): Promise<void> {
  const res = await request.post(`${API}/agents/${agentId}/media`, {
    headers: authHeaders(),
    multipart: {
      description,
      source: "text",
      file: {
        name: fileName,
        mimeType,
        buffer: Buffer.from(content, "utf8"),
      },
    },
  });

  if (!res.ok()) {
    throw new Error(`Media upload failed with ${res.status()}`);
  }
}

export async function setAgentPinsViaDB(
  agentId: string,
  pins: AgentPinRecord[]
): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed agent pins.");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      "UPDATE agents SET pins = $2::jsonb, updated_at = NOW() WHERE id = $1",
      [agentId, JSON.stringify(pins)]
    );
  } finally {
    await pool.end();
  }
}

export async function setAgentRoleViaDB(
  agentId: string,
  role: "standard" | "assisted_update"
): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed agent roles.");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      "UPDATE agents SET role = $2, updated_at = NOW() WHERE id = $1",
      [agentId, role]
    );
  } finally {
    await pool.end();
  }
}

/**
 * Seed a row directly into `agent_messages`, bypassing the real
 * dispatch_send_message path (which requires two running tmux agents and
 * cannot run in the inert-runtime E2E stack). `agent_messages` has no FK
 * constraints, so the "other" participant id can be any string.
 */
export async function seedAgentMessageViaDB(message: {
  senderAgentId: string;
  recipientAgentId: string;
  senderName: string;
  recipientName: string;
  content: string;
  delivered?: boolean;
  read?: boolean;
  senderRepoRoot?: string | null;
  recipientRepoRoot?: string | null;
}): Promise<string> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed agent messages.");
  }

  const id = randomUUID();
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      `INSERT INTO agent_messages
         (id, sender_agent_id, recipient_agent_id, sender_name, recipient_name,
          content, delivered, read_at, sender_repo_root, recipient_repo_root)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        message.senderAgentId,
        message.recipientAgentId,
        message.senderName,
        message.recipientName,
        message.content,
        message.delivered ?? true,
        message.read ? new Date() : null,
        message.senderRepoRoot ?? null,
        message.recipientRepoRoot ?? null,
      ]
    );
  } finally {
    await pool.end();
  }
  return id;
}

export async function seedReviewAgentFixtureViaDB(
  parentAgentId: string
): Promise<{
  activeAgentId: string;
  openReviewAgentId: string;
  approvedAgentId: string;
  openReviewId: number;
  standardChildAgentId: string;
}> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed review agent fixtures.");
  }

  const ids = {
    activeAgentId: `${parentAgentId}-active-review`,
    openReviewAgentId: `${parentAgentId}-open-review`,
    approvedAgentId: `${parentAgentId}-approved-review`,
    standardChildAgentId: `${parentAgentId}-task`,
  };
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const child of [
        {
          id: ids.activeAgentId,
          name: "active reviewer",
          persona: "ux-review",
          status: "running",
        },
        {
          id: ids.openReviewAgentId,
          name: "reviewer with feedback",
          persona: "release-readiness-review",
          status: "stopped",
        },
        {
          id: ids.approvedAgentId,
          name: "approving reviewer",
          persona: "architecture-review",
          status: "stopped",
        },
      ]) {
        await client.query(
          `INSERT INTO agents (
             id, name, type, role, status, cwd, codex_args, full_access, pins,
             persona, parent_agent_id, created_at, updated_at
           ) VALUES ($1, $2, 'claude', 'review', $3, '/tmp', '[]'::jsonb,
             false, '[]'::jsonb, $4, $5, NOW(), NOW())`,
          [child.id, child.name, child.status, child.persona, parentAgentId]
        );
      }
      await client.query(
        `INSERT INTO agents (
           id, name, type, role, status, cwd, codex_args, full_access, pins,
           parent_agent_id, created_at, updated_at
         ) VALUES ($1, 'standard task child', 'claude', 'standard', 'stopped',
           '/tmp', '[]'::jsonb, false, '[]'::jsonb, $2, NOW(), NOW())`,
        [ids.standardChildAgentId, parentAgentId]
      );

      const openReview = await client.query<{ id: number }>(
        `INSERT INTO reviews (
           agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id,
           summary, status
         ) VALUES ($1, $1, 'agent', $2, $3, 'open') RETURNING id`,
        [
          parentAgentId,
          ids.openReviewAgentId,
          "Found one actionable loading-state issue.",
        ]
      );
      const item = await client.query<{ id: number }>(
        `INSERT INTO review_feedback_items (
           review_id, file_path, line_start, status
         ) VALUES ($1, $2, 56, 'open') RETURNING id`,
        [openReview.rows[0]!.id, "apps/web/src/components/LoadingState.tsx"]
      );
      await client.query(
        `INSERT INTO review_thread_messages (
           feedback_item_id, author_type, author_agent_id, content
         ) VALUES ($1, 'agent', $2, $3)`,
        [
          item.rows[0]!.id,
          ids.openReviewAgentId,
          JSON.stringify({
            body: "Retry spinner never settles after a timeout.",
          }),
        ]
      );
      await client.query(
        `INSERT INTO reviews (
           agent_id, assigned_agent_id, reviewer_type, reviewer_agent_id,
           summary, status
         ) VALUES ($1, $1, 'agent', $2, $3, 'resolved')`,
        [
          parentAgentId,
          ids.approvedAgentId,
          "Approved after checking the changed architecture boundaries.",
        ]
      );
      await client.query("COMMIT");
      return { ...ids, openReviewId: openReview.rows[0]!.id };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Delete an agent via the REST API (force-stops and cleans up worktrees).
 */
export async function deleteAgentViaAPI(
  request: APIRequestContext,
  agentId: string,
  cleanupWorktree: "auto" | "keep" | "force" = "force"
): Promise<void> {
  await request
    .post(`${API}/agents/${agentId}/stop`, {
      headers: authHeaders(),
      data: { force: true },
    })
    .catch(() => {});
  await request.delete(
    `${API}/agents/${agentId}?force=true&cleanupWorktree=${cleanupWorktree}`,
    {
      headers: authHeaders(),
    }
  );
  // Archive is async — poll until the agent is actually gone
  for (let i = 0; i < 50; i++) {
    try {
      const res = await request.get(`${API}/agents/${agentId}`, {
        headers: authHeaders(),
      });
      if (res.status() === 404) return;
    } catch {
      // The isolated API server can briefly drop connections during teardown.
      // Treat that as retryable instead of failing the whole suite cleanup.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Clean up agents created during tests.
 *
 * Default ("tracked") mode only deletes agents created by `createAgentViaAPI`
 * in this worker process — safe to call from parallel workers.
 *
 * Pass "all" to delete every `e2e-agent-*` agent and its children.
 * Only use "all" from tests that run with a single worker (serial suite).
 */
export async function cleanupE2EAgents(
  request: APIRequestContext,
  mode: "tracked" | "all" = "tracked"
): Promise<void> {
  if (mode === "tracked") {
    const ids = [...trackedAgentIds];
    trackedAgentIds.clear();
    // Also delete sub-agents (e.g. persona reviewers)
    if (ids.length > 0) {
      const res = await request.get(`${API}/agents`, {
        headers: authHeaders(),
      });
      const body = (await res.json()) as {
        agents?: Array<{
          id: string;
          name: string;
          parentAgentId?: string | null;
        }>;
      };
      const parentSet = new Set(ids);
      const toDelete = new Set(ids);
      for (const agent of body.agents ?? []) {
        if (agent.parentAgentId && parentSet.has(agent.parentAgentId)) {
          toDelete.add(agent.id);
        }
      }
      await Promise.all(
        [...toDelete].map((id) => deleteAgentViaAPI(request, id))
      );
    }
    return;
  }

  const res = await request.get(`${API}/agents`, { headers: authHeaders() });
  const body = (await res.json()) as {
    agents?: Array<{ id: string; name: string; parentAgentId?: string | null }>;
  };
  if (!body.agents) return;
  const parentIds = new Set(
    body.agents
      .filter((agent) => agent.name.startsWith("e2e-agent-"))
      .map((agent) => agent.id)
  );
  const toDelete = body.agents.filter(
    (agent) =>
      agent.name.startsWith("e2e-agent-") ||
      (agent.parentAgentId && parentIds.has(agent.parentAgentId))
  );
  await Promise.all(
    toDelete.map((agent) => deleteAgentViaAPI(request, agent.id))
  );
  trackedAgentIds.clear();
}

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type DemoSeedRow = {
  agent_id: string;
  event_type: "working" | "blocked" | "waiting_user" | "done";
  message: string;
  metadata: string;
  created_at: Date;
  agent_type: string;
  agent_name: string;
  project_dir: string;
};

function buildDemoActivitySeed(now = new Date()): DemoSeedRow[] {
  const projects = [
    { dir: "/tmp/dispatch-demo", agentType: "codex" },
    { dir: "/tmp/ios-client-demo", agentType: "claude" },
    { dir: "/tmp/marketing-site-demo", agentType: "opencode" },
  ];
  const dayCount = 420;
  const rows: DemoSeedRow[] = [];
  const start = new Date(now.getTime() - dayCount * 24 * 60 * 60 * 1000);

  for (let dayOffset = 0; dayOffset < dayCount; dayOffset += 1) {
    const day = new Date(start.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const weekday = day.getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const projectIndex = weekend ? dayOffset % 2 : dayOffset % projects.length;
    const project = projects[projectIndex];
    const random = mulberry32(dayOffset * 97 + projectIndex * 131 + 17);

    const activeAgents = weekend
      ? random() > 0.58
        ? 1
        : 0
      : random() > 0.82
        ? 3
        : 2;
    for (let agentIndex = 0; agentIndex < activeAgents; agentIndex += 1) {
      const startHour = weekend
        ? 9 + Math.floor(random() * 6)
        : 8 + Math.floor(random() * 3) + (agentIndex === 2 ? 1 : 0);
      const startMinute = Math.floor(random() * 40);
      const workingBlockMinutes = weekend
        ? 70 + Math.floor(random() * 80)
        : 105 + Math.floor(random() * 85);
      const blockedMinutes =
        random() > (weekend ? 0.78 : 0.55) ? 0 : 10 + Math.floor(random() * 35);
      const waitingMinutes =
        random() > (weekend ? 0.88 : 0.68) ? 0 : 8 + Math.floor(random() * 28);
      const reviewBlockMinutes = weekend
        ? 20 + Math.floor(random() * 40)
        : 45 + Math.floor(random() * 55);
      const agentId = `seed-active-hours-${projectIndex}-${agentIndex}`;
      const agentName = weekend
        ? `Weekend ${agentIndex + 1}`
        : `Builder ${projectIndex + 1}-${agentIndex + 1}`;

      const workingAt = new Date(
        Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          startHour,
          startMinute
        )
      );
      rows.push({
        agent_id: agentId,
        event_type: "working",
        message: "Deep work block",
        metadata: JSON.stringify({ seed: "activity-demo", phase: "working" }),
        created_at: workingAt,
        agent_type: project.agentType,
        agent_name: agentName,
        project_dir: project.dir,
      });

      let cursor = new Date(
        workingAt.getTime() + workingBlockMinutes * 60 * 1000
      );
      if (blockedMinutes > 0) {
        rows.push({
          agent_id: agentId,
          event_type: "blocked",
          message: "Waiting on review feedback",
          metadata: JSON.stringify({ seed: "activity-demo", phase: "blocked" }),
          created_at: cursor,
          agent_type: project.agentType,
          agent_name: agentName,
          project_dir: project.dir,
        });
        cursor = new Date(cursor.getTime() + blockedMinutes * 60 * 1000);
      }

      if (waitingMinutes > 0) {
        rows.push({
          agent_id: agentId,
          event_type: "waiting_user",
          message: "Need a product call",
          metadata: JSON.stringify({ seed: "activity-demo", phase: "waiting" }),
          created_at: cursor,
          agent_type: project.agentType,
          agent_name: agentName,
          project_dir: project.dir,
        });
        cursor = new Date(cursor.getTime() + waitingMinutes * 60 * 1000);
      }

      rows.push({
        agent_id: agentId,
        event_type: "working",
        message: "Afternoon execution",
        metadata: JSON.stringify({ seed: "activity-demo", phase: "wrap-up" }),
        created_at: cursor,
        agent_type: project.agentType,
        agent_name: agentName,
        project_dir: project.dir,
      });
      cursor = new Date(cursor.getTime() + reviewBlockMinutes * 60 * 1000);

      rows.push({
        agent_id: agentId,
        event_type: "done",
        message: "Shipped for the day",
        metadata: JSON.stringify({ seed: "activity-demo", phase: "done" }),
        created_at: cursor,
        agent_type: project.agentType,
        agent_name: agentName,
        project_dir: project.dir,
      });
    }
  }

  return rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}

export async function seedActivityDemoViaDB(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to seed activity demo data.");
  }

  const pool = new Pool({ connectionString, max: 1 });
  const rows = buildDemoActivitySeed();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM agent_events
       WHERE metadata::text LIKE '%"seed":"activity-demo"%'`
    );
    const insertSql = `INSERT INTO agent_events
      (agent_id, event_type, message, metadata, created_at, agent_type, agent_name, project_dir)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`;

    for (const row of rows) {
      await client.query(insertSql, [
        row.agent_id,
        row.event_type,
        row.message,
        row.metadata,
        row.created_at,
        row.agent_type,
        row.agent_name,
        row.project_dir,
      ]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Navigate to the app root and wait for the shell to be ready
 * (sidebar rendered + health polling started).
 */
export async function loadApp(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // On a fresh DB with no password, the app loads directly.
  // If a password is set and user isn't authenticated, the login page shows.
  const loginInput = page.getByTestId("login-password");
  const sidebar = page.getByTestId("agent-sidebar");

  await Promise.race([
    loginInput.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
    sidebar.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
  ]);

  // If login page is showing, that's unexpected in e2e (fresh DB = no password).
  // But handle it gracefully just in case.
  if (await loginInput.isVisible().catch(() => false)) {
    throw new Error(
      "Unexpected login page in e2e test — DB should have no password set."
    );
  }

  await sidebar.waitFor({ state: "visible", timeout: 15_000 });
  await page
    .getByTestId("terminal-pane")
    .waitFor({ state: "visible", timeout: 10_000 });
}
