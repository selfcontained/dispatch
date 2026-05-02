import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  COPY_MODE_ASSIST_ENABLED_KEY,
  getCopyModeAssistEnabled,
  parseBooleanSetting,
} from "../copy-mode-assist-settings.js";
import { deleteSetting, getSetting, setSetting } from "../db/settings.js";
import { JobService } from "../jobs/service.js";
import {
  AGENT_TYPES,
  getEnabledAgentTypes,
  setEnabledAgentTypes,
} from "../agent-type-settings.js";
import { IDE_TYPES, getEnabledIdes, setEnabledIdes } from "../ide-settings.js";
import {
  SlackNotifier,
  isValidSlackWebhookUrl,
} from "../notifications/slack.js";
import { runCommand } from "../shared/lib/run-command.js";
import { shouldSkipAutomaticMacPathProbe } from "../shared/mac-path-privacy.js";

const WORKTREE_LOCATION_KEY = "worktree_location";
const INSTANCE_NAME_KEY = "instance_name";
const VALID_WORKTREE_LOCATIONS = ["sibling", "nested"] as const;

function resolveTildePath(raw: string): string {
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  if (raw === "~") return os.homedir();
  return raw;
}

type SystemRouteDeps = {
  pool: Pool;
  appLog: FastifyBaseLogger;
  slackNotifier: SlackNotifier;
  iconColorKey: string;
  validIconColors: readonly string[];
  getCachedIconColor: () => string;
  rewriteForColor: (color: string) => void;
  pendingGitRefreshEnqueuedAt: Map<string, number>;
  gitRefreshDurationsMs: number[];
  gitRefreshAgentDiagnostics: Map<
    string,
    {
      lastQueuedAt: number | null;
      lastStartedAt: number | null;
      lastCompletedAt: number | null;
      lastDurationMs: number | null;
      lastResult:
        | "updated"
        | "unchanged"
        | "probe_error"
        | "failed"
        | "skipped"
        | null;
      lastError: string | null;
    }
  >;
  pendingGitRefreshAgentIds: Set<string>;
  activeGitRefreshAgentIds: Set<string>;
  gitRefreshCounters: {
    enqueued: number;
    started: number;
    completed: number;
    updated: number;
    unchanged: number;
    probeErrors: number;
    failed: number;
    timedOut: number;
    skipped: number;
  };
  probeCommandTimeoutMs: number;
  gitContextRefreshIntervalMs: number;
  gitContextRefreshConcurrency: number;
  percentile: (sortedValues: number[], quantile: number) => number | null;
  toIso: (epochMs: number | null) => string | null;
  publishUiEvent: (event: unknown) => void;
  copyModeAssistManager: {
    disableAll: () => Promise<void>;
  };
};

export async function registerSystemRoutes(
  app: FastifyInstance,
  deps: SystemRouteDeps
): Promise<void> {
  app.get("/api/v1/app/branding", async () => {
    return { iconColor: deps.getCachedIconColor() };
  });

  app.get("/api/v1/health", async () => {
    const result = await deps.pool.query("SELECT NOW() AS now");
    return {
      status: "ok",
      db: "ok",
      now: result.rows[0]?.now,
    };
  });

  app.get("/ping", async () => {
    return { status: "ok" };
  });

  app.post("/api/v1/clipboard/image", async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply
        .code(400)
        .send({ error: "An image file field is required." });
    }
    const mime = data.mimetype;
    if (!mime.startsWith("image/")) {
      return reply.code(400).send({ error: "Only image files are accepted." });
    }

    const buffer = await data.toBuffer();
    const ext =
      mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "png";
    const tmpPath = `/tmp/dispatch-clipboard-${Date.now()}.${ext}`;
    await writeFile(tmpPath, buffer);

    try {
      if (os.platform() === "darwin") {
        const pasteboardClass = ext === "jpg" ? "JPEG" : "PNGf";
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("osascript", [
            "-e",
            `set the clipboard to (read (POSIX file "${tmpPath}") as «class ${pasteboardClass}»)`,
          ]);
          proc.on("close", (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`osascript exited ${code}`))
          );
          proc.on("error", reject);
        });
      } else {
        const display = process.env.DISPATCH_COPY_DISPLAY;
        if (!display) {
          return reply.code(500).send({
            error:
              "DISPATCH_COPY_DISPLAY is not set. Clipboard image paste on Linux requires Xvfb and xclip.",
          });
        }
        await new Promise<void>((resolve, reject) => {
          const proc = spawn(
            "xclip",
            ["-selection", "clipboard", "-t", mime, "-i", tmpPath],
            { env: { ...process.env, DISPLAY: display } }
          );
          proc.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`xclip exited ${code}`))
          );
          proc.on("error", reject);
        });
      }
      return reply.code(200).send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply
        .code(500)
        .send({ error: `Failed to write to clipboard: ${message}` });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  app.get("/api/v1/system/defaults", async () => {
    return { homeDir: os.homedir() };
  });

  app.get("/api/v1/system/path-info", async (request, reply) => {
    const query = request.query as { path?: unknown };
    if (typeof query?.path !== "string" || !query.path.trim()) {
      return reply
        .code(400)
        .send({ error: "path query parameter is required." });
    }
    const resolved = resolveTildePath(query.path.trim());
    if (!path.isAbsolute(resolved)) {
      return {
        exists: false,
        isDirectory: false,
        isGitRepo: false,
        privacyRestricted: false,
        resolvedPath: resolved,
      };
    }
    if (shouldSkipAutomaticMacPathProbe(resolved, os.homedir())) {
      return {
        exists: false,
        isDirectory: false,
        isGitRepo: false,
        privacyRestricted: true,
        resolvedPath: resolved,
      };
    }
    try {
      const info = await stat(resolved).catch(() => null);
      const exists = info !== null;
      const isDirectory = exists && info.isDirectory();
      let isGitRepo = false;
      if (isDirectory) {
        const result = await runCommand(
          "git",
          ["-C", resolved, "rev-parse", "--is-inside-work-tree"],
          { timeoutMs: 3_000, allowedExitCodes: [0, 1, 128] }
        );
        isGitRepo = result.exitCode === 0 && result.stdout.trim() === "true";
      }
      return {
        exists,
        isDirectory,
        isGitRepo,
        privacyRestricted: false,
        resolvedPath: resolved,
      };
    } catch {
      return {
        exists: false,
        isDirectory: false,
        isGitRepo: false,
        privacyRestricted: false,
        resolvedPath: resolved,
      };
    }
  });

  app.get("/api/v1/system/path-completions", async (request, reply) => {
    const query = request.query as { prefix?: unknown };
    if (typeof query?.prefix !== "string" || !query.prefix.trim()) {
      return reply
        .code(400)
        .send({ error: "prefix query parameter is required." });
    }
    const raw = query.prefix.trim();
    const resolved = resolveTildePath(raw);
    if (!path.isAbsolute(resolved)) {
      return { completions: [] };
    }
    try {
      const parentDir = path.dirname(resolved);
      const partial = path.basename(resolved).toLowerCase();
      const isExactDir = raw.endsWith("/");
      const searchDir = isExactDir ? resolved : parentDir;
      const searchPartial = isExactDir ? "" : partial;

      if (shouldSkipAutomaticMacPathProbe(searchDir, os.homedir())) {
        return { completions: [], privacyRestricted: true };
      }

      const entries = await readdir(searchDir, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          if (entry.name.startsWith(".") && !searchPartial.startsWith(".")) {
            return false;
          }
          return entry.name.toLowerCase().startsWith(searchPartial);
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20)
        .map((entry) => path.join(searchDir, entry.name));

      const homeDir = os.homedir();
      const completions = dirs.map((dir) =>
        raw.startsWith("~") && dir.startsWith(homeDir)
          ? "~" + dir.slice(homeDir.length)
          : dir
      );

      return { completions, privacyRestricted: false };
    } catch {
      return { completions: [], privacyRestricted: false };
    }
  });

  app.get("/api/v1/git/branches", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    if (typeof query?.cwd !== "string" || !query.cwd.trim()) {
      return reply
        .code(400)
        .send({ error: "cwd query parameter is required." });
    }
    try {
      const cwd = resolveTildePath(query.cwd.trim());
      const result = await runCommand(
        "git",
        ["-C", cwd, "ls-remote", "--heads", "origin"],
        { timeoutMs: 15_000 }
      );
      if (result.exitCode !== 0) {
        return reply
          .code(500)
          .send({ error: "Failed to list remote branches." });
      }
      const branches = result.stdout
        .split("\n")
        .map((line) => line.replace(/^.*refs\/heads\//, "").trim())
        .filter(Boolean)
        .sort((a, b) => {
          if (a === "main") return -1;
          if (b === "main") return 1;
          if (a === "master") return -1;
          if (b === "master") return 1;
          return a.localeCompare(b);
        });
      return { branches };
    } catch {
      return reply.code(500).send({ error: "Failed to list remote branches." });
    }
  });

  app.get("/api/v1/agents/settings", async () => {
    const raw = await getSetting(deps.pool, WORKTREE_LOCATION_KEY);
    const worktreeLocation =
      raw && (VALID_WORKTREE_LOCATIONS as readonly string[]).includes(raw)
        ? raw
        : "sibling";
    const instanceName = (await getSetting(deps.pool, INSTANCE_NAME_KEY)) ?? "";
    const copyModeAssistEnabled = await getCopyModeAssistEnabled(deps.pool);
    return {
      worktreeLocation,
      iconColor: deps.getCachedIconColor(),
      instanceName,
      copyModeAssistEnabled,
    };
  });

  app.post("/api/v1/agents/settings", async (request, reply) => {
    const body = request.body as {
      worktreeLocation?: unknown;
      iconColor?: unknown;
      instanceName?: unknown;
      copyModeAssistEnabled?: unknown;
    };

    if (body.worktreeLocation !== undefined) {
      if (
        typeof body.worktreeLocation !== "string" ||
        !(VALID_WORKTREE_LOCATIONS as readonly string[]).includes(
          body.worktreeLocation
        )
      ) {
        return reply
          .code(400)
          .send({ error: 'worktreeLocation must be "sibling" or "nested".' });
      }
      await setSetting(deps.pool, WORKTREE_LOCATION_KEY, body.worktreeLocation);
    }

    if (body.iconColor !== undefined) {
      if (
        typeof body.iconColor !== "string" ||
        !deps.validIconColors.includes(body.iconColor)
      ) {
        return reply.code(400).send({
          error: `iconColor must be one of: ${deps.validIconColors.join(", ")}`,
        });
      }
      await setSetting(deps.pool, deps.iconColorKey, body.iconColor);
      deps.rewriteForColor(body.iconColor);
    }

    if (body.instanceName !== undefined) {
      if (typeof body.instanceName !== "string") {
        return reply
          .code(400)
          .send({ error: "instanceName must be a string." });
      }
      const trimmed = body.instanceName.trim().slice(0, 100);
      if (trimmed) {
        await setSetting(deps.pool, INSTANCE_NAME_KEY, trimmed);
      } else {
        await deleteSetting(deps.pool, INSTANCE_NAME_KEY);
      }
    }

    if (body.copyModeAssistEnabled !== undefined) {
      if (typeof body.copyModeAssistEnabled !== "boolean") {
        return reply.code(400).send({
          error: "copyModeAssistEnabled must be a boolean.",
        });
      }
      const previousValue = parseBooleanSetting(
        await getSetting(deps.pool, COPY_MODE_ASSIST_ENABLED_KEY),
        false
      );
      await setSetting(
        deps.pool,
        COPY_MODE_ASSIST_ENABLED_KEY,
        String(body.copyModeAssistEnabled)
      );
      deps.publishUiEvent({ type: "agents.settings_changed" });
      if (previousValue && !body.copyModeAssistEnabled) {
        await deps.copyModeAssistManager.disableAll();
      }
    }

    const raw = await getSetting(deps.pool, WORKTREE_LOCATION_KEY);
    const worktreeLocation =
      raw && (VALID_WORKTREE_LOCATIONS as readonly string[]).includes(raw)
        ? raw
        : "sibling";
    const instanceName = (await getSetting(deps.pool, INSTANCE_NAME_KEY)) ?? "";
    const copyModeAssistEnabled = await getCopyModeAssistEnabled(deps.pool);
    return {
      worktreeLocation,
      iconColor: deps.getCachedIconColor(),
      instanceName,
      copyModeAssistEnabled,
    };
  });

  app.get("/api/v1/notifications/settings", async () => {
    return deps.slackNotifier.getSettings();
  });

  app.post("/api/v1/notifications/settings", async (request, reply) => {
    const body = request.body as {
      webhookUrl?: unknown;
      notifyEvents?: unknown;
      webNotifyEnabled?: unknown;
      webNotifyEvents?: unknown;
    } | null;

    if (body?.webhookUrl !== undefined) {
      if (typeof body.webhookUrl !== "string") {
        return reply.code(400).send({ error: "webhookUrl must be a string." });
      }
      if (body.webhookUrl && !isValidSlackWebhookUrl(body.webhookUrl)) {
        return reply.code(400).send({
          error: "webhookUrl must start with https://hooks.slack.com/",
        });
      }
      await deps.slackNotifier.setWebhookUrl(body.webhookUrl);
    }
    if (body?.notifyEvents !== undefined) {
      if (!Array.isArray(body.notifyEvents)) {
        return reply
          .code(400)
          .send({ error: "notifyEvents must be an array." });
      }
      await deps.slackNotifier.setNotifyEvents(body.notifyEvents as string[]);
    }
    if (body?.webNotifyEnabled !== undefined) {
      if (typeof body.webNotifyEnabled !== "boolean") {
        return reply
          .code(400)
          .send({ error: "webNotifyEnabled must be a boolean." });
      }
      await deps.slackNotifier.setWebNotifyEnabled(body.webNotifyEnabled);
    }
    if (body?.webNotifyEvents !== undefined) {
      if (!Array.isArray(body.webNotifyEvents)) {
        return reply
          .code(400)
          .send({ error: "webNotifyEvents must be an array." });
      }
      await deps.slackNotifier.setWebNotifyEvents(
        body.webNotifyEvents as string[]
      );
    }

    return deps.slackNotifier.getSettings();
  });

  app.post("/api/v1/notifications/test", async (request, reply) => {
    const body = request.body as { webhookUrl?: unknown } | null;
    const url =
      typeof body?.webhookUrl === "string"
        ? body.webhookUrl
        : await deps.slackNotifier.getWebhookUrl();
    if (!url) {
      return reply
        .code(400)
        .send({ error: "No webhook URL provided or configured." });
    }
    if (!isValidSlackWebhookUrl(url)) {
      return reply
        .code(400)
        .send({ error: "webhookUrl must start with https://hooks.slack.com/" });
    }
    return deps.slackNotifier.sendTestMessage(url);
  });

  app.get("/api/v1/app/settings/agent-types", async () => {
    return { enabledAgentTypes: await getEnabledAgentTypes(deps.pool) };
  });

  app.post("/api/v1/app/settings/agent-types", async (request, reply) => {
    const body = request.body as { enabledAgentTypes?: unknown } | null;
    if (!Array.isArray(body?.enabledAgentTypes)) {
      return reply
        .code(400)
        .send({ error: "enabledAgentTypes must be an array." });
    }

    const uniqueTypes = body.enabledAgentTypes
      .filter(
        (value): value is (typeof AGENT_TYPES)[number] =>
          typeof value === "string" &&
          AGENT_TYPES.includes(value as (typeof AGENT_TYPES)[number])
      )
      .filter((value, index, values) => values.indexOf(value) === index);

    if (uniqueTypes.length === 0) {
      return reply
        .code(400)
        .send({ error: "At least one agent type must remain enabled." });
    }

    if (uniqueTypes.length !== body.enabledAgentTypes.length) {
      return reply.code(400).send({
        error: `enabledAgentTypes must only include ${AGENT_TYPES.join(", ")}.`,
      });
    }

    return {
      enabledAgentTypes: await setEnabledAgentTypes(deps.pool, uniqueTypes),
    };
  });

  app.get("/api/v1/app/settings/ides", async () => {
    return { enabledIdes: await getEnabledIdes(deps.pool) };
  });

  app.post("/api/v1/app/settings/ides", async (request, reply) => {
    const body = request.body as { enabledIdes?: unknown } | null;
    if (!Array.isArray(body?.enabledIdes)) {
      return reply.code(400).send({ error: "enabledIdes must be an array." });
    }

    const uniqueIdes = body.enabledIdes
      .filter(
        (value): value is (typeof IDE_TYPES)[number] =>
          typeof value === "string" &&
          IDE_TYPES.includes(value as (typeof IDE_TYPES)[number])
      )
      .filter((value, index, values) => values.indexOf(value) === index);

    if (uniqueIdes.length !== body.enabledIdes.length) {
      return reply.code(400).send({
        error: `enabledIdes must only include ${IDE_TYPES.join(", ")}.`,
      });
    }

    return { enabledIdes: await setEnabledIdes(deps.pool, uniqueIdes) };
  });

  app.post("/api/v1/energy-report", async (request, reply) => {
    try {
      deps.appLog.info(
        { energyMetrics: request.body },
        "PWA energy metrics report"
      );
    } catch {}
    return reply.status(204).send();
  });

  app.get("/api/v1/diagnostics/git-context", async () => {
    const now = Date.now();
    const pendingAges = Array.from(
      deps.pendingGitRefreshEnqueuedAt.values()
    ).map((queuedAt) => Math.max(0, now - queuedAt));
    const oldestPendingAgeMs =
      pendingAges.length > 0 ? Math.max(...pendingAges) : null;
    const durations = [...deps.gitRefreshDurationsMs].sort((a, b) => a - b);
    const p50DurationMs = deps.percentile(durations, 0.5);
    const p95DurationMs = deps.percentile(durations, 0.95);
    const maxDurationMs =
      durations.length > 0 ? durations[durations.length - 1] : null;
    const lastDurationMs =
      deps.gitRefreshDurationsMs.length > 0
        ? deps.gitRefreshDurationsMs[deps.gitRefreshDurationsMs.length - 1]
        : null;

    const agents = Array.from(deps.gitRefreshAgentDiagnostics.entries())
      .map(([agentId, diag]) => ({
        agentId,
        pending: deps.pendingGitRefreshAgentIds.has(agentId),
        active: deps.activeGitRefreshAgentIds.has(agentId),
        lastQueuedAt: deps.toIso(diag.lastQueuedAt),
        lastStartedAt: deps.toIso(diag.lastStartedAt),
        lastCompletedAt: deps.toIso(diag.lastCompletedAt),
        lastDurationMs: diag.lastDurationMs,
        lastResult: diag.lastResult,
        lastError: diag.lastError,
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));

    return {
      config: {
        intervalMs: deps.gitContextRefreshIntervalMs,
        concurrency: deps.gitContextRefreshConcurrency,
        probeTimeoutMs: deps.probeCommandTimeoutMs,
      },
      queue: {
        pending: deps.pendingGitRefreshAgentIds.size,
        active: deps.activeGitRefreshAgentIds.size,
        oldestPendingAgeMs,
      },
      counters: deps.gitRefreshCounters,
      durationsMs: {
        samples: durations.length,
        p50: p50DurationMs,
        p95: p95DurationMs,
        max: maxDurationMs,
        last: lastDurationMs,
      },
      agents,
    };
  });
}
