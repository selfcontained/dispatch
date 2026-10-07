export type Tip = {
  id: string;
  title: string;
  body: string;
  docsSection?: string;
  since: string;
  desktopOnly?: boolean;
};

export const tips: Tip[] = [
  {
    id: "quick-phrases",
    title: "Quick Phrases",
    body: "Inject saved phrases into your terminal session with one click. Create reusable snippets for common commands.",
    docsSection: "agents#quick-phrases",
    since: "0.23.0",
  },
  {
    id: "uncommitted-diff",
    title: "Filter Uncommitted Changes",
    body: "Choose whether Changes includes uncommitted work.",
    docsSection: "agents#split-tabs",
    since: "0.28.2",
  },
  {
    id: "split-tabs",
    title: "Split Tabs",
    body: "Drag the Changes tab to the left or right side of the center pane to compare the diff beside the live terminal. Use the split handle to resize or unsplit.",
    docsSection: "agents#split-tabs",
    since: "0.27.4",
    desktopOnly: true,
  },
];

export function getTipById(id: string): Tip | undefined {
  return tips.find((t) => t.id === id);
}
