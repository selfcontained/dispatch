export type Surface = "inline" | "ambient";

export type Tip = {
  id: string;
  title: string;
  body: string;
  docsSection?: string;
  since: string;
  surfaces: Surface[];
};

export const tips: Tip[] = [
  {
    id: "quick-phrases",
    title: "Quick Phrases",
    body: "Inject saved phrases into your terminal session with one click. Create reusable snippets for common commands.",
    docsSection: "agents#quick-phrases",
    since: "0.23.0",
    surfaces: ["inline", "ambient"],
  },
  {
    id: "personas",
    title: "Personas",
    body: "Launch specialized review agents with structured feedback. Define reusable roles for security, UX, or code review.",
    docsSection: "personas",
    since: "0.22.0",
    surfaces: ["inline", "ambient"],
  },
  {
    id: "brain",
    title: "Brain",
    body: "Repo-scoped shared memory that persists across agent sessions. Store objects, lists, and event logs your agents can access.",
    docsSection: "tools#brain",
    since: "0.20.0",
    surfaces: ["inline", "ambient"],
  },
  {
    id: "automations",
    title: "Automations",
    body: "Schedule recurring jobs like PR triage, dependency checks, or custom workflows on a cron schedule.",
    docsSection: "automations",
    since: "0.18.0",
    surfaces: ["inline", "ambient"],
  },
  {
    id: "media-sidebar",
    title: "Media Sidebar",
    body: "View agent pins, screenshots, and shared media in a collapsible sidebar. Pin it to keep it visible while you work.",
    docsSection: "media",
    since: "0.19.0",
    surfaces: ["inline", "ambient"],
  },
];

export function getTipById(id: string): Tip | undefined {
  return tips.find((t) => t.id === id);
}
