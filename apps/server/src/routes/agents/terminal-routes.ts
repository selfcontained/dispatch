import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { getQuickPhrase } from "../../db/quick-phrases.js";
import { spawn as spawnPty } from "../../shared/terminal/bun-pty.js";
import { substituteArgs } from "../../templates/arg-parser.js";
import { TmuxTerminal } from "../../terminal/tmux-terminal.js";
import { errorMessage } from "../../shared/lib/error-message.js";
import { decodeClientMessage, type AgentRouteDeps } from "./shared.js";

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

  app.post("/api/v1/agents/:id/terminal/inject", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as { text?: unknown } | null;
    const id = params.id ?? "";
    const text = typeof body?.text === "string" ? body.text : "";

    const TEXT_INJECT_MAX = 10_000;
    if (!text) {
      return reply.code(400).send({ error: "text is required." });
    }
    if (text.length > TEXT_INJECT_MAX) {
      return reply.code(400).send({
        error: `text must be ${TEXT_INJECT_MAX} characters or fewer.`,
      });
    }

    try {
      const access = await deps.agentManager.getTerminalAccess(id);
      if (access.mode !== "tmux") {
        return reply.code(409).send({ error: access.message });
      }

      const terminal = new TmuxTerminal(access.sessionName);
      await terminal.sendCommand(text);
      return reply.code(204).send();
    } catch (error) {
      return deps.handleAgentError(reply, error);
    }
  });

  app.post(
    "/api/v1/agents/:id/terminal/inject-phrase",
    async (request, reply) => {
      const params = request.params as { id?: string };
      const body = request.body as {
        phraseId?: unknown;
        args?: unknown;
      } | null;
      const agentId = params.id ?? "";
      const phraseId = typeof body?.phraseId === "string" ? body.phraseId : "";

      if (!phraseId) {
        return reply.code(400).send({ error: "phraseId is required." });
      }

      const phrase = await getQuickPhrase(deps.pool, phraseId);
      if (!phrase) {
        return reply.code(404).send({ error: "Phrase not found." });
      }

      const args =
        body?.args && typeof body.args === "object" && !Array.isArray(body.args)
          ? (body.args as Record<string, string>)
          : {};

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

      try {
        const access = await deps.agentManager.getTerminalAccess(agentId);
        if (access.mode !== "tmux") {
          return reply.code(409).send({ error: access.message });
        }

        const terminal = new TmuxTerminal(access.sessionName);
        await terminal.sendCommand(text);
        return reply.code(204).send();
      } catch (error) {
        return deps.handleAgentError(reply, error);
      }
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
