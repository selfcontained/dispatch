import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { getQuickPhrase } from "../../db/quick-phrases.js";
import { spawn as spawnPty } from "../../shared/terminal/bun-pty.js";
import { substituteArgs } from "../../templates/arg-parser.js";
import { TmuxTerminal } from "../../terminal/tmux-terminal.js";
import { errorMessage } from "../../shared/lib/error-message.js";
import { resolveShortcutRun } from "../../agents/pin-run.js";
import { ChatServiceError } from "../../chat/service.js";
import {
  deliverUserPrompt,
  type UserPromptDeps,
} from "../../chat/user-prompt.js";
import { decodeClientMessage, type AgentRouteDeps } from "./shared.js";

/**
 * The routes' deps, narrowed to what a user-fired prompt's delivery needs.
 * With the Chat surface on it becomes a Chat message — a user post in the
 * feed, wrapped in the envelope — so the agent's reply threads back to it
 * exactly as it would for a message typed in the composer.
 */
function promptDeps(deps: AgentRouteDeps): UserPromptDeps {
  return {
    isChatSurfaceEnabled: deps.isChatSurfaceEnabled,
    getAgent: (agentId) => deps.agentManager.getAgent(agentId),
    sendUserMessage: (agentId, text) =>
      deps.chat.sendUserMessage(agentId, text),
  };
}

export async function registerAgentTerminalRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  app.post("/api/v1/agents/:id/terminal/token", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const access = await deps.agentManager.getTerminalAccess(id);
      if (access.mode === "inert") {
        return {
          mode: "inert" as const,
          message: access.message,
        };
      }
      const token = deps.issueTerminalToken(id);
      return {
        mode: "tmux" as const,
        token,
        wsUrl: `/api/v1/agents/${id}/terminal/ws?token=${token}`,
      };
    } catch (error) {
      const refreshed = await deps.agentManager.getAgent(id);
      if (refreshed) {
        deps.publishUiEvent({
          type: "agent.upsert",
          agent: deps.withStreamFlag(refreshed),
        });
      }
      return deps.handleAgentError(reply, error);
    }
  });

  app.post(
    "/api/v1/agents/:id/terminal/copy-mode/exit",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const id = params.id ?? "";

      try {
        const access = await deps.agentManager.getTerminalAccess(id);
        if (access.mode !== "tmux") {
          return reply.code(409).send({ error: access.message });
        }

        deps.copyModeObserverManager.noteInteraction(
          id,
          access.sessionName,
          "exit_copy_mode"
        );
        const terminal = new TmuxTerminal(access.sessionName);
        await terminal.exitCopyMode();
        return reply.code(204).send();
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  app.get("/api/v1/agents/:id/terminal/state", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const access = await deps.agentManager.getTerminalAccess(id);
      if (access.mode !== "tmux") {
        return reply.code(409).send({ error: access.message });
      }

      return {
        terminalState: await deps.copyModeObserverManager.getState(
          id,
          access.sessionName
        ),
      };
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post(
    "/api/v1/agents/:id/terminal/interaction",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const body = request.body as { interaction?: unknown };
      const id = params.id ?? "";

      if (body?.interaction !== "scroll") {
        return reply.code(400).send({ error: "interaction must be 'scroll'." });
      }

      try {
        const access = await deps.agentManager.getTerminalAccess(id);
        if (access.mode !== "tmux") {
          return reply.code(409).send({ error: access.message });
        }

        deps.injectionCoordinator.noteUserActivity(id);
        deps.copyModeObserverManager.noteInteraction(
          id,
          access.sessionName,
          body.interaction
        );
        return reply.code(204).send();
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  app.post(
    "/api/v1/agents/:id/terminal/inject-phrase",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const body = request.body as {
        phraseId?: unknown;
        args?: unknown;
        submit?: unknown;
      } | null;
      const agentId = params.id ?? "";
      const phraseId = typeof body?.phraseId === "string" ? body.phraseId : "";
      const submit = body?.submit !== false;

      if (!phraseId) {
        return reply.code(400).send({ error: "phraseId is required." });
      }

      const phrase = await getQuickPhrase(deps.pool, phraseId);
      if (!phrase) {
        return reply.code(404).send({ error: "Phrase not found." });
      }

      const TEXT_INJECT_MAX = 10_000;
      const ARG_VALUE_MAX = 2_000;
      const rawArgs =
        body?.args && typeof body.args === "object" && !Array.isArray(body.args)
          ? (body.args as Record<string, unknown>)
          : {};

      const args: Record<string, string> = {};
      for (const [key, val] of Object.entries(rawArgs)) {
        if (typeof val !== "string") {
          return reply
            .code(400)
            .send({ error: `arg "${key}" must be a string.` });
        }
        if (val.length > ARG_VALUE_MAX) {
          return reply.code(400).send({
            error: `arg "${key}" must be ${ARG_VALUE_MAX} characters or fewer.`,
          });
        }
        args[key] = val;
      }

      let text: string;
      try {
        text = substituteArgs(phrase.text, args);
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error
              ? error.message
              : "Failed to substitute variables.",
        });
      }

      if (text.length > TEXT_INJECT_MAX) {
        return reply.code(400).send({
          error: `Rendered phrase must be ${TEXT_INJECT_MAX} characters or fewer.`,
        });
      }

      try {
        if (await deliverUserPrompt(promptDeps(deps), agentId, text, submit)) {
          return reply.code(204).send();
        }

        const access = await deps.agentManager.getTerminalAccess(agentId);
        if (access.mode !== "tmux") {
          return reply.code(409).send({ error: access.message });
        }

        const terminal = new TmuxTerminal(access.sessionName);
        // User-initiated: skip the quiet gate (the click IS the user acting)
        // but serialize against any in-flight automated injection.
        await deps.injectionCoordinator.inject(
          agentId,
          () =>
            submit ? terminal.sendCommand(text) : terminal.pasteText(text),
          { gate: false }
        );
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof ChatServiceError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        return deps.handleAgentError(reply, error);
      }
    }
  );

  // Mobile fullscreen keyboard input: the client sends raw typed text here
  // instead of writing it straight to the pty over the terminal WS, so it
  // goes through the same tmux paste-buffer path as quick phrases/pins
  // (bracketed paste), which is what makes multi-line text land as a single
  // paste instead of one line at a time.
  app.post(
    "/api/v1/agents/:id/terminal/inject-text",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const body = request.body as { text?: unknown; submit?: unknown } | null;
      const agentId = params.id ?? "";
      const text = typeof body?.text === "string" ? body.text : "";
      const submit = body?.submit !== false;

      if (!text) {
        return reply.code(400).send({ error: "text is required." });
      }

      const TEXT_INJECT_MAX = 10_000;
      if (text.length > TEXT_INJECT_MAX) {
        return reply.code(400).send({
          error: `text must be ${TEXT_INJECT_MAX} characters or fewer.`,
        });
      }

      try {
        const access = await deps.agentManager.getTerminalAccess(agentId);
        if (access.mode !== "tmux") {
          return reply.code(409).send({ error: access.message });
        }

        const terminal = new TmuxTerminal(access.sessionName);
        // User-initiated: skip the quiet gate (the click IS the user acting)
        // but serialize against any in-flight automated injection.
        await deps.injectionCoordinator.inject(
          agentId,
          () =>
            submit ? terminal.sendCommand(text) : terminal.pasteText(text),
          { gate: false }
        );
        return reply.code(204).send();
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
    }
  );

  // Shortcut pins: the click delivers the pin's stored prompt to the owning
  // agent's session. The prompt is looked up server-side by pin ID so the
  // client can only fire prompts the agent itself pinned. Like quick phrases,
  // the click IS the user acting, so it skips the quiet gate but still
  // serializes against in-flight injections.
  app.post(
    "/api/v1/agents/:id/terminal/inject-pin/:pinId",
    async (request, reply) => {
      const params = request.params as { id?: string; pinId?: string };
      const agentId = params.id ?? "";
      const pinId = params.pinId ?? "";

      try {
        const agent = await deps.agentManager.getAgent(agentId);
        if (!agent) {
          return reply.code(404).send({ error: "Agent not found." });
        }

        const target = resolveShortcutRun(agent.pins, pinId);
        if (!target.ok) {
          return reply.code(target.status).send({ error: target.error });
        }

        if (
          await deliverUserPrompt(
            promptDeps(deps),
            agentId,
            target.prompt,
            true
          )
        ) {
          return reply.code(204).send();
        }

        const access = await deps.agentManager.getTerminalAccess(agentId);
        if (access.mode !== "tmux") {
          return reply.code(409).send({ error: access.message });
        }

        const terminal = new TmuxTerminal(access.sessionName);
        await deps.injectionCoordinator.inject(
          agentId,
          () => terminal.sendCommand(target.prompt),
          { gate: false }
        );
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof ChatServiceError) {
          return reply.code(error.statusCode).send({ error: error.message });
        }
        return deps.handleAgentError(reply, error);
      }
    }
  );

  // "Send now" for a held injection: skip the quiet gate for everything
  // currently queued for this agent.
  app.post(
    "/api/v1/agents/:id/terminal/release-injections",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const id = params.id ?? "";

      const agent = await deps.agentManager.getAgent(id);
      if (!agent) {
        return reply.code(404).send({ error: "Agent not found." });
      }

      deps.injectionCoordinator.releaseHold(id);
      return reply.code(204).send();
    }
  );

  app.get(
    "/api/v1/agents/:id/terminal/ws",
    { websocket: true },
    async (socket, request) => {
      const params = request.params as { id?: string };
      const query = request.query as {
        token?: string;
        cols?: string;
        rows?: string;
      };
      const agentId = params.id ?? "";
      const token = query.token ?? "";

      if (!deps.consumeTerminalToken(agentId, token)) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: "Invalid or expired terminal token.",
          })
        );
        socket.close(1008, "invalid token");
        return;
      }

      let tmuxSession: string;
      const assistState = {
        activeRef: { current: false },
        connectionId: null as string | null,
      };
      try {
        const access = await deps.agentManager.getTerminalAccess(agentId);
        if (access.mode !== "tmux") {
          throw new Error(access.message);
        }
        tmuxSession = access.sessionName;
        const detachCopyModeViewer = deps.copyModeObserverManager.attachViewer(
          agentId,
          tmuxSession,
          randomUUID()
        );
        const assistConnection = await deps.copyModeAssistManager.attach(
          tmuxSession,
          detachCopyModeViewer
        );
        assistState.activeRef = assistConnection.activeRef;
        assistState.connectionId = assistConnection.connectionId;
      } catch (error) {
        socket.send(
          JSON.stringify({ type: "error", message: errorMessage(error) })
        );
        socket.close(1011, "attach failed");
        return;
      }
      const cols = Number(query.cols ?? 140);
      const rows = Number(query.rows ?? 42);
      const ptyProcess = spawnPty(
        "tmux",
        ["-u", "attach-session", "-t", tmuxSession],
        {
          name: "xterm-256color",
          cols: Number.isFinite(cols) ? cols : 140,
          rows: Number.isFinite(rows) ? rows : 42,
        }
      );

      const sendJson = (payload: unknown): void => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };
      ptyProcess.onData((data) => {
        sendJson({ type: "output", data });
      });

      ptyProcess.onExit((event) => {
        sendJson({ type: "exit", exitCode: event.exitCode });
        socket.close(1000, "terminal exited");
      });

      const heartbeatTimer = setInterval(() => {
        sendJson({ type: "heartbeat", ts: Date.now() });
      }, 20_000);

      socket.on("message", (buffer) => {
        const message = decodeClientMessage(buffer);
        if (!message) {
          sendJson({ type: "error", message: "Invalid message payload." });
          return;
        }

        if (message.type === "input") {
          if (!message.data) {
            return;
          }
          deps.injectionCoordinator.noteUserActivity(agentId);
          ptyProcess.write(message.data);
          return;
        }

        if (message.type === "resize") {
          if (message.cols > 0 && message.rows > 0) {
            ptyProcess.resize(message.cols, message.rows);
          }
          return;
        }

        if (message.type === "interaction") {
          deps.injectionCoordinator.noteUserActivity(agentId);
          if (assistState.activeRef.current) {
            deps.copyModeObserverManager.noteInteraction(
              agentId,
              tmuxSession,
              message.interaction
            );
          }
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeatTimer);
        if (assistState.connectionId) {
          void deps.copyModeAssistManager.detach(assistState.connectionId);
        }
        try {
          ptyProcess.kill();
        } catch {}
      });
    }
  );
}
