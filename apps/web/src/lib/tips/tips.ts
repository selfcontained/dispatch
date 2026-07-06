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
    id: "agent-orchestration",
    title: "Agent Orchestration",
    body: "Agents can now launch other agents using the dispatch_launch_agent tool. Delegate subtasks, run parallel workstreams, or hand off work — launched agents coordinate via messaging.",
    docsSection: "tools#dispatch-launch-agent",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
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
    body: "Repo-scoped shared memory that persists across agent sessions. Store objects, lists, and event logs your agents can manage.",
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
  {
    id: "file-upload",
    title: "File Upload",
    body: "Drag and drop files onto the terminal to upload and inject them into the agent's prompt. You can also paste images from your clipboard.",
    docsSection: "media#uploading-files",
    since: "0.23.6",
    surfaces: ["ambient"],
  },
  {
    id: "changes-tab",
    title: "Changes Tab",
    body: "Switch to the Changes tab next to Terminal to browse an agent's diff. Use the gear icon to toggle split/unified view and hide whitespace changes.",
    docsSection: "agents",
    since: "0.23.9",
    surfaces: ["ambient"],
  },
  {
    id: "session-rename",
    title: "Rename Sessions",
    body: "Expand an agent in the sidebar and click the edit button to open session settings and rename it directly.",
    docsSection: "agents",
    since: "0.23.13",
    surfaces: ["ambient"],
  },
  {
    id: "keyboard-shortcuts",
    title: "Keyboard Shortcuts",
    body: "Press ⌘K to open the command palette. Navigate agents, toggle sidebars, and control the terminal without touching the mouse.",
    docsSection: "shortcuts",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
  {
    id: "terminal-focus-shortcut",
    title: "Terminal Focus Shortcut",
    body: "Press ⌘⇧Space to jump back to the terminal input from anywhere in Dispatch.",
    docsSection: "shortcuts",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
  {
    id: "sidebar-shortcuts",
    title: "Sidebar Shortcuts",
    body: "Press ⌘⇧< to toggle the agent sidebar, or ⌘⇧> to toggle the media sidebar.",
    docsSection: "shortcuts",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
  {
    id: "agent-navigation-shortcuts",
    title: "Agent Navigation Shortcuts",
    body: "Press ⌘⇧↑ or ⌘⇧↓ to move between top-level agents without leaving the keyboard.",
    docsSection: "shortcuts",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
  {
    id: "command-palette-shortcut",
    title: "Command Palette Shortcut",
    body: "Press ⌘K to search commands, open settings pages, or launch palette-enabled templates.",
    docsSection: "shortcuts",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
  {
    id: "worktrees",
    title: "Worktrees",
    body: "Each agent gets its own git worktree by default — isolated branches, no conflicts. Run multiple agents in parallel on the same repo.",
    docsSection: "worktrees",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
  {
    id: "personalities",
    title: "Personalities",
    body: "Customize how agents communicate. Add a personality to shape tone, preferences, or standing instructions across all new agents.",
    docsSection: "personalities",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
  {
    id: "notifications",
    title: "Notifications",
    body: "Get notified when agents finish, need input, or get stuck. Set up Slack, browser, or sound alerts in Settings.",
    docsSection: "notifications",
    since: "0.24.0",
    surfaces: ["ambient"],
  },
];

export function getTipById(id: string): Tip | undefined {
  return tips.find((t) => t.id === id);
}
