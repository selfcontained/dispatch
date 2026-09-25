import { randomUUID } from "node:crypto";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AgentPermissionRequest } from "@dispatch/shared";

/** Kept in the host, so reconnecting the server neither loses nor grants consent. */
export class PermissionRequests {
  private pending = new Map<
    string,
    {
      agentId: string;
      request: AgentPermissionRequest;
      resolve: (response: RequestPermissionResponse) => void;
    }
  >();

  constructor(private changed: (agentId: string) => void) {}

  list(agentId: string): AgentPermissionRequest[] {
    return [...this.pending.values()]
      .filter((p) => p.agentId === agentId)
      .map((p) => p.request);
  }

  ask(
    agentId: string,
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const id = randomUUID();
    const tool = params.toolCall;
    const details = [
      tool.rawInput == null ? "" : JSON.stringify(tool.rawInput, null, 2),
      ...(tool.content ?? []).flatMap((part) =>
        part.type === "content" && part.content.type === "text"
          ? [part.content.text]
          : part.type === "diff"
            ? [`${part.path}\n${part.newText}`]
            : []
      ),
      ...(tool.locations ?? []).map((location) => location.path),
    ]
      .filter(Boolean)
      .join("\n\n");
    const request: AgentPermissionRequest = {
      id,
      toolCallId: tool.toolCallId,
      title: (tool.title || "Tool permission requested").slice(0, 1024),
      details:
        details.length > 16_000
          ? `${details.slice(0, 16_000)}\n… [truncated]`
          : details,
      createdAt: new Date().toISOString(),
      options: params.options.map(({ optionId, name, kind }) => ({
        optionId,
        name,
        kind,
      })),
    };
    return new Promise((resolve) => {
      this.pending.set(id, { agentId, request, resolve });
      this.changed(agentId);
    });
  }

  answer(agentId: string, requestId: string, optionId: string | null): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.agentId !== agentId)
      throw new Error("This permission request is no longer pending.");
    if (
      optionId !== null &&
      !pending.request.options.some((o) => o.optionId === optionId)
    ) {
      throw new Error("The engine did not offer that permission choice.");
    }
    this.pending.delete(requestId);
    this.changed(agentId);
    pending.resolve({
      outcome:
        optionId === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId },
    });
  }

  cancel(agentId: string): void {
    for (const request of this.list(agentId))
      this.answer(agentId, request.id, null);
  }
}
