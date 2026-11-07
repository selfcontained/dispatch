export type BackgroundItem = {
  id: string;
  name: string;
  kind: "shell" | "monitor";
  state: "running" | "paused";
};
/** A live host-memory snapshot. Never persisted or reconstructed from history. */
export type BackgroundSnapshot = {
  status: "supported" | "unsupported" | "offline" | "unavailable";
  items: BackgroundItem[];
};
