import { Post } from "./chat/chat-entries";
import {
  SystemEventEntry,
  type SystemEventPresentation,
} from "./chat/system-event-entry";

const resource = {
  label: "PR #1439 · Preserve observation delivery provenance",
  url: "https://github.com",
};
const head = "0c935fb3a917c37c9aa095f03e4b0da15a3b73a2";
const events: SystemEventPresentation[] = [
  ...(["routine", "human_review", "abstain"] as const).map((risk) => ({
    category: "risk" as const,
    summary: "Merge-risk assessment",
    risk,
    resource,
    head,
    details:
      risk === "abstain"
        ? "Assessment inconclusive: insufficient evidence. Checks are reported independently."
        : "Assessment applies to this head only. Checks are reported independently.",
  })),
  ...(["Passing", "Failing", "Pending"] as const).map((status) => ({
    category: "checks" as const,
    summary: "Pull request checks",
    status,
    resource,
    head,
    details:
      "Type check · Production build · Browser regression coverage with a deliberately long check label\nStatus observed at 10:42. No merge action taken.",
  })),
  {
    category: "lifecycle",
    summary: "Pull request merged",
    resource,
    head,
    details: "Lifecycle changed from Open to Merged.",
  },
  {
    category: "info",
    summary: "Scheduled message paused",
    details: "The schedule is paused. No message was delivered.",
  },
];
export function SystemEventsCheckpoint() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-2 text-lg font-semibold">
        Compact system events · Design checkpoint
      </h1>
      <p className="mb-4 text-xs text-muted-foreground">
        Staged feed examples for visual approval. Informational observations do
        not authorize actions.
      </p>
      <Post
        author={{ key: "user", kind: "user", name: "You" }}
        at="2026-11-10T17:40:00Z"
        grouped={false}
      >
        Keep me informed about this pull request.
      </Post>
      <div className="my-3 space-y-2">
        {events.map((event, i) => (
          <SystemEventEntry key={i} event={event} />
        ))}
      </div>
      <Post
        author={{ key: "agent", kind: "agent", name: "Builder" }}
        at="2026-11-10T17:43:00Z"
        grouped={false}
      >
        The observations are retained in the feed. I’ll wait for your review
        before merging.
      </Post>
    </div>
  );
}
