export type AgentStatus = "creating" | "running" | "stopping" | "stopped" | "error" | "unknown";

export type Agent = {
  id: string;
  name: string;
  type?: string;
  status: AgentStatus;
  cwd: string;
  tmuxSession: string | null;
  codexArgs: string[];
  lastError?: string | null;
  mediaDir: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaFile = {
  name: string;
  size: number;
  updatedAt: string;
  url: string;
};

export type ConnState = "connected" | "reconnecting" | "disconnected";
export type ServiceState = "ok" | "down" | "checking";
export type AgentVisualState = "stopped" | "idle" | "active";
