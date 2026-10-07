/** A live engine request, owned by the agent host until answered or cancelled. */
export type AgentPermissionRequest = {
  id: string;
  toolCallId: string;
  title: string;
  /** Plain text preview of the requested operation, never executable markup. */
  details: string;
  createdAt: string;
  options: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
};

export type AgentPermissionsResponse = {
  connected: boolean;
  requests: AgentPermissionRequest[];
};
