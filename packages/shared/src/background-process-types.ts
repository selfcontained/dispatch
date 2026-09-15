export type BackgroundProcess = {
  id: string;
  agentId: string;
  title: string;
  command: string;
  cwd: string;
  status: "running" | "completed" | "failed" | "stopped" | "interrupted";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  output: string;
  truncated: boolean;
};

export type BackgroundProcessInput = {
  command: string;
  title: string;
  timeoutSeconds?: number;
};
