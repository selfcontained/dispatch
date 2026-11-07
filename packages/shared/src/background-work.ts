export type BackgroundItem = {
  id: string;
  generation: string;
  sessionId: string;
  provider: "claude" | "codex";
  source?: "acp-asyncTasks";
  canStop?: boolean;
  showInTranscript?: boolean;
  name?: string;
  taskType?: "shell" | "monitor";
  description?: string;
  summary?: string;
  toolCallId?: string;
  state?: "running" | "paused" | "completed" | "failed" | "stopped";
  lastObservation: string;
  sequence: number;
  stale: boolean;
  originBlockId?: string;
  terminalOutput?: string;
};
export type BackgroundSnapshot = {
  generation?: string;
  generationStartedAt?: string;
  lastSequence?: number;
  capability: "unsupported" | "supported" | "unknown";
  stale: boolean;
  items: BackgroundItem[];
  truncated?: boolean;
};
