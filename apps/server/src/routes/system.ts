import {
  isAllowedSlackLinkOrigin,
  type SlackLinkOrigins,
} from "../notifications/slack-link-origins.js";
import type { SlackAnswers } from "../notifications/slack-answers.js";
import os from "node:os";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";

import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyRequest,
} from "fastify";
import type { Pool } from "pg";
import { z } from "zod";

import { deleteSetting, getSetting, setSetting } from "../db/settings.js";
import { JobService } from "../jobs/service.js";
import {
  AGENT_TYPES,
  getEnabledAgentTypes,
  setEnabledAgentTypes,
  type AgentType,
} from "../agent-type-settings.js";
import { IDE_TYPES, getEnabledIdes, setEnabledIdes } from "../ide-settings.js";
import { SlackNotifier, slackDelayError } from "../notifications/slack.js";
import {
  ModelAvailabilityError,
  updateModelAvailability,
} from "../agents/model-availability.js";
import { runCommand } from "../shared/lib/run-command.js";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import { shouldSkipAutomaticMacPathProbe } from "../shared/mac-path-privacy.js";
import {
  agentModelAvailability,
  agentModelCatalog,
  agentModelDefaults,
} from "../shared/agent-models.js";
import {
  engineStatuses,
  withEngineVersions,
} from "../agents/engine-availability.js";
import {
  assertWorktreeDirectoryUsable,
  getWorktreePlacement,
  isWorktreeLocation,
  WORKTREE_DIRECTORY_KEY,
  WORKTREE_LOCATION_KEY,
  WorktreeDirectoryError,
} from "../worktree-location-settings.js";

import {
  getUserAvatar,
  parseUserAvatar,
  setUserAvatar,
} from "../user-avatar-settings.js";

import {
  EngineUpdateOperations,
  engineOperationStore,
  withEngineUpdates,
} from "../agents/engine-updates.js";
import { ACP_ENGINE_IDS, type AcpEngineId } from "../agents/acp/engine-spec.js";

const INSTANCE_NAME_KEY = "instance_name";
const modelIdField = z.string().min(1).max(256);
const ModelAvailabilityBodySchema = z.union([
  z
    .object({ agentType: z.enum(AGENT_TYPES), autoEnable: z.boolean() })
    .strict(),
  z
    .object({
      agentType: z.enum(AGENT_TYPES),
      model: modelIdField,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      agentType: z.enum(AGENT_TYPES),
      seen: z.array(modelIdField).min(1).max(1000),
    })
    .strict(),
]);

type SystemRouteDeps = {
  publishModelsChanged?: (agentType: AgentType) => void;
  notificationLinkOrigins?: () => Promise<SlackLinkOrigins>;
  slackAnswers?: Pick<
    SlackAnswers,
    "answerers" | "allow" | "revoke" | "createLink"
  >;
  pool: Pool;
  canManageEngineUpdates?: (request: FastifyRequest) => Promise<boolean>;
  appLog: FastifyBaseLogger;
  slackNotifier: SlackNotifier;
  iconColorKey: string;
  validIconColors: readonly string[];
  getCachedIconColor: () => string;
  rewriteForColor: (color: string) => void;
  /** The configured engine CLIs, so this reports what a launch would run. */
  maintenanceMode?: () => string;
  engineBins: { claude: string; codex: string; opencode?: string };
  localCertificateTrust?: boolean;
  /** Update recovery helper protocol; omitted in tests that don't need it. */
};

export async function registerSystemRoutes(
  app: FastifyInstance,
  deps: SystemRouteDeps
): Promise<void> {
  app.get("/api/v1/app/settings/user-avatar", async () => ({
    avatar: await getUserAvatar(deps.pool),
  }));
  app.put(
    "/api/v1/app/settings/user-avatar",
    { bodyLimit: 140_000 },
    async (request, reply) => {
      const avatar = parseUserAvatar(
        (request.body as { avatar?: unknown } | null)?.avatar
      );
      if (!avatar)
        return reply.code(400).send({
          error:
            "The prepared avatar could not be saved. Please try selecting the photo again.",
        });
      await setUserAvatar(deps.pool, avatar);
      return { avatar };
    }
  );

  app.get("/api/v1/app/branding", async () => {
    return { iconColor: deps.getCachedIconColor() };
  });

  app.get("/api/v1/system/certificate-trust", async () => ({
    available: deps.localCertificateTrust === true,
  }));

  app.get("/api/v1/health", async () => {
    const result = await deps.pool.query("SELECT NOW() AS now");
    const maintenance = deps.maintenanceMode?.() ?? "normal";
    return {
      status: "ok",
      db: "ok",
      now: result.rows[0]?.now,
      // Not a readiness signal: the helper uses the signed readiness route.
      ...(maintenance !== "normal" ? { maintenance } : {}),
      ...(process.env.DISPATCH_UPDATE_OWNER === "macos-app"
        ? {
            updateOwner: "macos-app",
            macInstanceId: process.env.DISPATCH_MAC_INSTANCE_ID ?? null,
          }
        : {}),
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

  const engineUpdates = new EngineUpdateOperations(
    engineOperationStore(deps.pool),
    {
      onError: (error) =>
        deps.appLog.error({ err: error }, "Engine update persistence failed"),
    }
  );
  app.get("/api/v1/system/engines", async (request) => {
    const operations = await engineUpdates.read();
    return {
      canManage: (await deps.canManageEngineUpdates?.(request)) ?? false,
      engines: await withEngineUpdates(
        await withEngineVersions(await engineStatuses(deps.engineBins))
      ).then((engines) =>
        engines.map((engine) => ({
          ...engine,
          update: {
            ...engine.update,
            operation: operations[engine.id] ?? null,
          },
        }))
      ),
    };
  });

  app.post("/api/v1/system/engines/:engine/update", async (request, reply) => {
    const { engine } = request.params as { engine: string };
    if (
      !(ACP_ENGINE_IDS as readonly string[]).includes(engine) ||
      request.body != null
    ) {
      return reply
        .code(400)
        .send({ error: "Provide only a supported engine ID in the URL." });
    }
    try {
      const operation = await engineUpdates.start(
        engine as AcpEngineId,
        deps.engineBins
      );
      return reply.code(202).send({ operation });
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Update unavailable.",
      });
    }
  });

  app.get("/api/v1/agent-models", async () => {
    return {
      models: agentModelCatalog(),
      defaults: agentModelDefaults(),
      availability: agentModelAvailability(),
    };
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

  const readAgentSettings = async () => {
    const { worktreeLocation } = await getWorktreePlacement(deps.pool);
    const instanceName = (await getSetting(deps.pool, INSTANCE_NAME_KEY)) ?? "";
    // The stored directory is returned even while another location is chosen,
    // so switching back to "directory" offers the folder used last time.
    const worktreeDirectory =
      (await getSetting(deps.pool, WORKTREE_DIRECTORY_KEY)) ?? "";
    return {
      worktreeLocation,
      worktreeDirectory,
      iconColor: deps.getCachedIconColor(),
      instanceName,
    };
  };

  app.get("/api/v1/agents/settings", readAgentSettings);

  app.post("/api/v1/agents/settings", async (request, reply) => {
    const body = request.body as {
      worktreeLocation?: unknown;
      worktreeDirectory?: unknown;
      iconColor?: unknown;
      instanceName?: unknown;
    };

    if (body.worktreeLocation !== undefined) {
      if (!isWorktreeLocation(body.worktreeLocation)) {
        return reply.code(400).send({
          error: 'worktreeLocation must be "sibling", "nested" or "directory".',
        });
      }
      if (
        body.worktreeDirectory !== undefined &&
        typeof body.worktreeDirectory !== "string"
      ) {
        return reply
          .code(400)
          .send({ error: "worktreeDirectory must be a string." });
      }
      if (body.worktreeLocation === "directory") {
        const requested =
          (body.worktreeDirectory as string | undefined) ??
          (await getSetting(deps.pool, WORKTREE_DIRECTORY_KEY)) ??
          "";
        let directory: string;
        try {
          directory = await assertWorktreeDirectoryUsable(requested);
        } catch (err) {
          if (err instanceof WorktreeDirectoryError) {
            return reply.code(400).send({ error: err.message });
          }
          throw err;
        }
        await setSetting(deps.pool, WORKTREE_DIRECTORY_KEY, directory);
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

    return readAgentSettings();
  });

  const notificationLinkOrigins = () =>
    deps.notificationLinkOrigins?.() ??
    Promise.resolve({ options: [], defaultUrl: null });
  const slackAppState = async () => ({
    ...(await deps.slackNotifier.app.settings()),
    answerers: (await deps.slackAnswers?.answerers()) ?? [],
  });
  app.get("/api/v1/notifications/slack-app", async () => ({
    ...(await slackAppState()),
    linkOrigins: await notificationLinkOrigins(),
  }));
  app.post(
    "/api/v1/notifications/slack-app/:action",
    async (request, reply) => {
      const { action } = request.params as { action: string };
      const body = request.body as Record<string, unknown> | null;
      try {
        if (action === "validate") {
          if (
            typeof body?.botToken !== "string" ||
            typeof body?.appToken !== "string"
          )
            return reply.code(400).send({ error: "Both tokens are required." });
          return await deps.slackNotifier.app.validate({
            botToken: body.botToken,
            appToken: body.appToken,
          });
        }
        if (action === "enable") {
          if (
            typeof body?.channelId !== "string" ||
            typeof body?.baseUrl !== "string"
          )
            return reply
              .code(400)
              .send({ error: "Choose a channel and Dispatch URL." });
          if (
            !isAllowedSlackLinkOrigin(
              body.baseUrl,
              await notificationLinkOrigins()
            )
          )
            return reply
              .code(400)
              .send({ error: "Choose an active Dispatch server address." });
          await deps.slackNotifier.app.enable(
            body.channelId,
            new URL(body.baseUrl).origin
          );
        } else if (action === "disconnect")
          await deps.slackNotifier.app.disconnect();
        else if (action === "recheck")
          await deps.slackNotifier.app.recheckPermissions();
        else if (action === "refresh")
          return { channels: await deps.slackNotifier.app.refreshChannels() };
        else if (action === "test")
          await deps.slackNotifier.app.send("Dispatch test notification");
        else if (action === "link" && deps.slackAnswers)
          await deps.slackAnswers.createLink();
        else if (
          (action === "allow" || action === "revoke") &&
          deps.slackAnswers
        ) {
          if (typeof body?.id !== "string")
            return reply.code(400).send({ error: "Choose a Slack account." });
          await deps.slackAnswers[action](body.id);
        } else return reply.code(404).send({ error: "Unknown Slack action." });
        return await slackAppState();
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Slack setup failed.",
        });
      }
    }
  );

  app.get("/api/v1/notifications/settings", async () => {
    return deps.slackNotifier.getSettings();
  });

  app.post("/api/v1/notifications/settings", async (request, reply) => {
    const body = request.body as {
      webNotifyEnabled?: unknown;
      webNotifyEvents?: unknown;
      slackAwayDelaySeconds?: unknown;
      slackPresentDelayMinutes?: unknown;
    } | null;

    const delayError = body ? slackDelayError(body) : null;
    if (delayError) return reply.code(400).send({ error: delayError });

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

    await deps.slackNotifier.setSlackDelays({
      slackAwayDelaySeconds: body?.slackAwayDelaySeconds as number | undefined,
      slackPresentDelayMinutes: body?.slackPresentDelayMinutes as
        | number
        | undefined,
    });

    return deps.slackNotifier.getSettings();
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

  app.patch("/api/v1/app/settings/agent-models", async (request, reply) => {
    const parsed = ModelAvailabilityBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error:
          "Send agentType with one of autoEnable, model and enabled, or seen.",
      });
    }
    const { agentType, ...change } = parsed.data;
    try {
      if (await updateModelAvailability(deps.pool, agentType, change))
        deps.publishModelsChanged?.(agentType);
    } catch (error) {
      if (error instanceof ModelAvailabilityError)
        return reply.code(400).send({ error: error.message });
      throw error;
    }
    return { availability: agentModelAvailability() };
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
}
