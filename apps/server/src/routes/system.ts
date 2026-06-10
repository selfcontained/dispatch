import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Pool } from "pg";

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
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import { hostClipboardImageCapable } from "../shared/lib/clipboard-capability.js";
import { shouldSkipAutomaticMacPathProbe } from "../shared/mac-path-privacy.js";

const WORKTREE_LOCATION_KEY = "worktree_location";
const INSTANCE_NAME_KEY = "instance_name";
const VALID_WORKTREE_LOCATIONS = ["sibling", "nested"] as const;

// A clipboard image is rarely more than a few MB; cap this route well below the
// global 20MB multipart limit since it buffers the whole image in memory and
// shells out to an external process per call.
const CLIPBOARD_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

// PID of the last detached xclip we spawned to own the Xvfb clipboard
// selection. We SIGTERM it before spawning a replacement so resident xclips
// don't stack up under a burst of pastes. This only tracks xclips spawned by
// THIS process: an xclip orphaned by a previous server instance is reparented
// to init and keeps owning the selection on the persistent Xvfb until its
// successor here displaces it, so operators may see one stale xclip per server
// restart. That's harmless — the next paste takes the selection.
let lastXclipPid: number | null = null;

/**
 * Poll the Xvfb clipboard until `xclip` actually owns the selection and
 * advertises our image target, so we don't tell the client to send Ctrl+V
 * before the image is readable. Returns false if ownership isn't observed
 * within `timeoutMs` (the caller then fails the request, and the client falls
 * back to a path-based upload).
 */
async function waitForClipboardSelection(
  display: string,
  mime: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCommand(
      "xclip",
      ["-selection", "clipboard", "-o", "-t", "TARGETS"],
      {
        env: { ...process.env, DISPLAY: display },
        timeoutMs: 1_000,
        allowedExitCodes: [0, 1],
      }
    ).catch(() => null);
    if (result && result.exitCode === 0 && result.stdout.includes(mime)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

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

  // Clipboard-image bridge: writes a browser-uploaded image to the host
  // clipboard so the agent CLI can paste it inline via Ctrl+V (macOS pasteboard
  // / Linux Xvfb+xclip). This route IS in active use: the terminal image-paste
  // path (use-terminal.ts `pasteImage`) POSTs here whenever GET
  // /system/defaults reports `clipboardImagePaste` true (the common macOS /
  // Linux+Xvfb case). Only terminal drag-and-drop is path-based and skips this
  // route — do not delete this endpoint unless the paste hybrid is also removed.
  // Rate-limited and size-capped because it buffers the image in memory and
  // spawns an external process per call.
  app.post(
    "/api/v1/clipboard/image",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!hostClipboardImageCapable()) {
        return reply.code(400).send({
          error:
            "This host cannot place an image on a CLI-readable clipboard. " +
            "Requires macOS, or Linux with Xvfb and DISPATCH_COPY_DISPLAY set.",
        });
      }
      const data = await request.file({
        limits: { fileSize: CLIPBOARD_IMAGE_MAX_BYTES },
      });
      if (!data) {
        return reply
          .code(400)
          .send({ error: "An image file field is required." });
      }
      const mime = data.mimetype;
      if (!mime.startsWith("image/")) {
        return reply
          .code(400)
          .send({ error: "Only image files are accepted." });
      }

      let buffer: Buffer;
      try {
        buffer = await data.toBuffer();
      } catch (err) {
        // @fastify/multipart throws when the per-request fileSize limit is hit
        // (it also flags data.file.truncated). Map that to 413; anything else
        // is a genuine read failure.
        const tooLarge =
          data.file.truncated ||
          (err as { code?: string })?.code === "FST_REQ_FILE_TOO_LARGE";
        if (tooLarge) {
          return reply.code(413).send({
            error: `Clipboard image exceeds the ${Math.round(
              CLIPBOARD_IMAGE_MAX_BYTES / (1024 * 1024)
            )}MB limit.`,
          });
        }
        return reply
          .code(500)
          .send({ error: "Failed to read uploaded image." });
      }
      // Only the macOS path needs a temp file (osascript reads from disk). The
      // Linux path streams the buffer straight to xclip's stdin, so we avoid a
      // pointless temp-file write/delete there.
      let tmpPath: string | null = null;

      try {
        if (os.platform() === "darwin") {
          const ext =
            mime === "image/png"
              ? "png"
              : mime === "image/jpeg"
                ? "jpg"
                : "png";
          // mkdtemp gives a private 0700 dir, so the predictable filename
          // inside it can't be pre-created or symlink-clobbered by another
          // user on a shared host the way a bare /tmp/<name> could.
          const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-clip-"));
          tmpPath = path.join(dir, `clipboard.${ext}`);
          await writeFile(tmpPath, buffer);
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
          // Linux branch is reached only when hostClipboardImageCapable() is
          // true, which on Linux requires DISPATCH_COPY_DISPLAY — so it is set.
          const display = process.env.DISPATCH_COPY_DISPLAY as string;
          // Replace the previous resident xclip (if any) before spawning a new
          // owner, so resident xclips don't stack up under a burst of pastes.
          if (lastXclipPid !== null) {
            try {
              process.kill(lastXclipPid, "SIGTERM");
            } catch {}
            lastXclipPid = null;
          }
          await new Promise<void>((resolve, reject) => {
            // xclip stays resident to OWN the X clipboard selection — it does
            // not exit until another app takes ownership. Waiting for "close"
            // would hang the request forever (the paste that would release it
            // can't happen until this request returns and the client sends
            // Ctrl+V). So feed the image via stdin, then poll until xclip
            // actually owns the selection before resolving; let it run
            // detached + unref'd.
            const proc = spawn(
              "xclip",
              ["-selection", "clipboard", "-t", mime],
              {
                env: { ...process.env, DISPLAY: display },
                stdio: ["pipe", "ignore", "pipe"],
                detached: true,
              }
            );
            lastXclipPid = proc.pid ?? null;
            let stderr = "";
            proc.stderr?.on("data", (chunk) => {
              stderr += String(chunk);
            });
            proc.on("error", reject);
            let settled = false;
            proc.on("exit", (code) => {
              // A quick non-zero exit (e.g. bad DISPLAY) is a real failure.
              if (!settled && code && code !== 0) {
                reject(new Error(`xclip exited ${code}: ${stderr.trim()}`));
              }
            });
            // Guard the stdin pipe: if xclip has already died (bad DISPLAY,
            // missing binary), writing the image buffer raises EPIPE on the
            // Writable. An unhandled stream 'error' is an uncaught exception
            // that would crash the whole server — reject instead (the catch
            // returns a 500). proc.on("error") only catches spawn failures,
            // not pipe writes.
            proc.stdin?.on("error", (err) => {
              if (!settled) reject(err);
            });
            proc.stdin?.end(buffer, () => {
              // Wait for a deterministic readiness signal — xclip owning the
              // selection and advertising our image target — rather than a
              // fixed delay. This closes the race where the client sent Ctrl+V
              // before xclip took the selection (which silently pasted nothing
              // and could NOT fall back, since the POST had already 200'd). On
              // timeout we reject so the client falls back to a path upload.
              void waitForClipboardSelection(display, mime, 2_000).then(
                (owned) => {
                  if (settled) return;
                  settled = true;
                  proc.unref();
                  if (owned) {
                    resolve();
                  } else {
                    reject(
                      new Error("xclip did not take the clipboard selection")
                    );
                  }
                }
              );
            });
          });
        }
        return reply.code(200).send({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply
          .code(500)
          .send({ error: `Failed to write to clipboard: ${message}` });
      } finally {
        if (tmpPath) await rm(path.dirname(tmpPath), { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  app.get("/api/v1/system/defaults", async () => {
    // Whether the host can put a browser-pasted image on a clipboard the agent
    // CLI can read. The web client uses this to decide whether Cmd/Ctrl+V
    // should attempt native clipboard paste vs. fall back to a path-based media
    // upload. Shares the predicate with POST /clipboard/image so the two can't
    // drift (see hostClipboardImageCapable).
    return {
      homeDir: os.homedir(),
      clipboardImagePaste: hostClipboardImageCapable(),
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
