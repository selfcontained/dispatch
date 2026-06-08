import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import { getCopyModeAssistEnabled } from "../../copy-mode-assist-settings.js";
import { spawn as spawnPty } from "../../shared/terminal/bun-pty.js";
import { TmuxTerminal } from "../../terminal/tmux-terminal.js";
import { errorMessage } from "../../shared/lib/error-message.js";
import {
  COPY_MODE_ASSIST_DISABLED_ERROR,
  decodeClientMessage,
  type AgentRouteDeps,
} from "./types.js";

export async function registerAgentTerminalRoutes(
  app: FastifyInstance,
  deps: AgentRouteDeps
): Promise<void> {
  const isCopyModeAssistEnabled = async (): Promise<boolean> => {
    return getCopyModeAssistEnabled(deps.pool);
  };

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
        if (!(await isCopyModeAssistEnabled())) {
          return reply
            .code(409)
            .send({ error: COPY_MODE_ASSIST_DISABLED_ERROR });
        }
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
      if (!(await isCopyModeAssistEnabled())) {
        return reply.code(409).send({ error: COPY_MODE_ASSIST_DISABLED_ERROR });
      }
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
        if (!(await isCopyModeAssistEnabled())) {
          return reply
            .code(409)
            .send({ error: COPY_MODE_ASSIST_DISABLED_ERROR });
        }
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
        // ⚠️ CRITICAL — this gate controls ONLY the copy-mode banner UI
        // and the passive observer. Tmux mouse mode (the actual scroll
        // mechanism) is enabled unconditionally at session launch in
        // runtime.ts. Do NOT pull mouse-mode setup, wheel listeners, or
        // any scroll plumbing inside this if-block — that's how PR #459
        // silently broke scroll for everyone with the toggle off.
        if (await isCopyModeAssistEnabled()) {
          const detachCopyModeViewer =
            deps.copyModeObserverManager.attachViewer(
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
        }
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
