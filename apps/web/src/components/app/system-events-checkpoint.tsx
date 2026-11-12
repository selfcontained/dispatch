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
    defaultOpen: risk === "abstain",
    resource,
    head,
    details:
      risk === "abstain"
        ? "Assessment inconclusive: insufficient evidence. Checks are reported independently."
        : "Assessment applies to this head only. Checks are reported independently.",
  })),
  ...(
    [
      [
        "Passing",
        "Passing · 3 passed",
        ["Type check — passed · 1m 4s", "Production build — passed · 2m"],
      ],
      [
        "Failing",
        "Failing · 4 passed, 1 failed, 2 pending",
        [
          "[Type check](<https://github.com/a/b/actions/runs/2>) — passed · 58s",
          "Unit tests — passed",
          "[Browser regression coverage with a deliberately long check lab…](<https://github.com/a/b/actions/runs/1>) — failed · 12m 30s",
          "+2 more",
        ],
      ],
      [
        "Pending",
        "Pending · 1 passed, 5 pending",
        ["[Lint](<https://github.com/a/b/actions/runs/3>) — passed · 20s"],
      ],
      [
        "Mixed",
        "Mixed · 2 passed, 1 cancelled, 1 skipped",
        ["Production build — passed · 2m 1s"],
      ],
    ] as const
  ).map(([status, header, lines]) => ({
    category: "checks" as const,
    summary: "Pull request checks",
    status,
    resource:
      status === "Pending"
        ? {
            label:
              "Fix Slack Socket Mode app identity and reinstall account linking across every connected workspace",
            url: "https://github.com/a/b/pull/1439",
          }
        : resource,
    head,
    details: [
      `[#1439](<https://github.com/a/b/pull/1439>) — ${header}`,
      ...lines.map((l) => `- ${l}`),
      "",
      "0c935fb3a917 · 2026-11-10 17:42Z · Info only; no action authorized.",
    ].join("\n"),
  })),
  {
    category: "checks",
    summary: "Pull request checks",
    resource,
    details: "",
  },
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
        Staged feed examples for visual approval. The “No recommendation”
        example starts with details open; check results are shown inline.
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
