export type PickerPageAccess = "ready" | "needs-site-access" | "unsupported";

export function classifyPickerPage(url?: string): PickerPageAccess {
  if (!url) return "needs-site-access";
  return /^https?:/i.test(url) ? "ready" : "unsupported";
}
