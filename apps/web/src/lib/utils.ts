import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const isSafeInset = (value: string) => /^safe(-|$)/.test(value);

// Every named token that shares a prefix with a colour utility (text-*,
// shadow-*) has to be listed here, or twMerge reads it as a colour and drops
// the real colour beside it. Keep in step with tailwind.config.ts.
const twMerge = extendTailwindMerge({
  extend: {
    theme: { borderRadius: ["mark", "xs", "screen"] },
    classGroups: {
      pt: [{ pt: [isSafeInset] }],
      pr: [{ pr: [isSafeInset] }],
      pb: [{ pb: [isSafeInset] }],
      pl: [{ pl: [isSafeInset] }],
      z: [
        {
          z: [
            "sticky",
            "raised",
            "dock",
            "drawer",
            "drawer-panel",
            "modal",
            "popover",
            "toast",
            "tooltip",
            "progress",
            "viewer",
            "viewer-modal",
            "viewer-popover",
            "viewer-menu",
          ],
        },
      ],
      "font-size": [
        {
          text: [
            "label-xs",
            "label-sm",
            "body-sm",
            "body-md",
            "body-lg",
            "code",
            "heading-sm",
            "heading-md",
            "heading-lg",
            "display",
          ],
        },
      ],
      shadow: [
        {
          shadow: [(value: string) => value.startsWith("elev-")],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
