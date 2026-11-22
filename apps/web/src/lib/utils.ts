import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Every named token that shares a prefix with a colour utility (text-*,
// shadow-*) has to be listed here, or twMerge reads it as a colour and drops
// the real colour beside it. Keep in step with tailwind.config.ts.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
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
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
