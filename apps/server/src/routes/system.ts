import os from "node:os";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { deleteSetting, getSetting, setSetting } from "../db/settings.js";
import {
  isCrossRepoMessagingEnabled,
  setCrossRepoMessagingEnabled,
} from "../cross-repo-messaging-settings.js";
import {
  loadInjectionHoldEnabled,
  setInjectionHoldEnabled,
} from "../injection-hold-settings.js";
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
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import { shouldSkipAutomaticMacPathProbe } from "../shared/mac-path-privacy.js";
import { AGENT_MODEL_OPTIONS } from "../shared/agent-models.js";

const WORKTREE_LOCATION_KEY = "worktree_location";
const INSTANCE_NAME_KEY = "instance_name";
const VALID_WORKTREE_LOCATIONS = ["sibling", "nested"] as const;

type SystemRouteDeps = {
  pool: Pool;
  appLog: FastifyBaseLogger;
  slackNotifier: SlackNotifier;
  iconColorKey: string;
  validIconColors: readonly string[];
  getCachedIconColor: () => string;
  rewriteForColor: (color: string) => void;
  publishUiEvent: (event: unknown) => void;
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

  app.get("/api/v1/system/defaults", async () => {
    return {
      homeDir: os.homedir(),
    };
  });

  app.get("/api/v1/agent-models", async () => {
    return { models: AGENT_MODEL_OPTIONS };
  });

  app.get("/api/v1/system/path-info", async (request, reply) => {
    const query = request.query as { path?: unknown };
    if (typeof query?.path !== "string" || !query.path.trim()) {
      return reply
        .code(400)
        .send({ error: "path query parameter is required." });
    }
    const resolved = resolveTilde(query.path.trim());
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
    const resolved = resolveTilde(raw);
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
      const cwd = resolveTilde(query.cwd.trim());
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
    return {
      worktreeLocation,
      iconColor: deps.getCachedIconColor(),
      instanceName,
    };
  });

  app.post("/api/v1/agents/settings", async (request, reply) => {
    const body = request.body as {
      worktreeLocation?: unknown;
      iconColor?: unknown;
      instanceName?: unknown;
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

    const raw = await getSetting(deps.pool, WORKTREE_LOCATION_KEY);
    const worktreeLocation =
      raw && (VALID_WORKTREE_LOCATIONS as readonly string[]).includes(raw)
        ? raw
        : "sibling";
    const instanceName = (await getSetting(deps.pool, INSTANCE_NAME_KEY)) ?? "";
    return {
      worktreeLocation,
      iconColor: deps.getCachedIconColor(),
      instanceName,
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

  app.get("/api/v1/app/settings/injection-hold", async () => {
    // Authoritative read: hits the DB and re-syncs the in-memory cache, so a
    // failed boot load or interleaved POSTs self-heal whenever settings open.
    // The injection hot path keeps using the sync cache.
    return { enabled: await loadInjectionHoldEnabled(deps.pool) };
  });

  app.post("/api/v1/app/settings/injection-hold", async (request, reply) => {
    const body = request.body as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled must be a boolean." });
    }
    await setInjectionHoldEnabled(deps.pool, body.enabled);
    return { enabled: body.enabled };
  });

  app.get("/api/v1/app/settings/cross-repo-messaging", async () => {
    return { enabled: await isCrossRepoMessagingEnabled(deps.pool) };
  });

  app.post(
    "/api/v1/app/settings/cross-repo-messaging",
    async (request, reply) => {
      const body = request.body as { enabled?: unknown } | null;
      if (typeof body?.enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled must be a boolean." });
      }
      await setCrossRepoMessagingEnabled(deps.pool, body.enabled);
      return { enabled: body.enabled };
    }
  );

  app.post("/api/v1/energy-report", async (request, reply) => {
    try {
      deps.appLog.info(
        { energyMetrics: request.body },
        "PWA energy metrics report"
      );
    } catch {}
    return reply.status(204).send();
  });
}
