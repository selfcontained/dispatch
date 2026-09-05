import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

/** `pointer-coarse:` — touch-first devices, where tap targets need ≥44px. */
const pointerCoarse = plugin(({ addVariant }) => {
  addVariant("pointer-coarse", "@media (pointer: coarse)");
});

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: "hsl(var(--surface))",
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        status: {
          working: "hsl(var(--status-working) / <alpha-value>)",
          blocked: "hsl(var(--status-blocked) / <alpha-value>)",
          waiting: "hsl(var(--status-waiting) / <alpha-value>)",
          done: "hsl(var(--status-done) / <alpha-value>)",
          idle: "hsl(var(--status-idle) / <alpha-value>)",
          reviewing: "hsl(var(--status-reviewing) / <alpha-value>)",
        },
        chart: {
          1: "hsl(var(--chart-1) / <alpha-value>)",
          2: "hsl(var(--chart-2) / <alpha-value>)",
          3: "hsl(var(--chart-3) / <alpha-value>)",
          4: "hsl(var(--chart-4) / <alpha-value>)",
          5: "hsl(var(--chart-5) / <alpha-value>)",
          6: "hsl(var(--chart-6) / <alpha-value>)",
        },
        "heading-accent": {
          1: "hsl(var(--heading-accent-1) / <alpha-value>)",
          2: "hsl(var(--heading-accent-2) / <alpha-value>)",
        },
      },
      borderRadius: {
        lg: "0.75rem",
        md: "0.6rem",
        sm: "0.45rem",
      },
      keyframes: {
        "chat-enter": {
          from: { opacity: "0", transform: "translateY(3px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Harness view (PromptKit port): a step row sliding into the rail.
        "harness-row": {
          from: { opacity: "0", transform: "translateY(-2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // A settled result turn fading in.
        "harness-msg": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // The ✓ glyph landing on a completed step.
        "harness-pop": {
          "0%": { transform: "scale(0.6)", opacity: "0" },
          "60%": { transform: "scale(1.15)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        "mobile-toolbar-flash": {
          "0%": {
            backgroundColor: "rgba(255,255,255,0.06)",
            boxShadow:
              "0 1px 4px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06)",
          },
          "18%": {
            backgroundColor: "rgba(190,240,255,0.14)",
            boxShadow:
              "0 1px 4px rgba(0,0,0,0.2), inset 0 0 0 1px rgba(190,240,255,0.22), inset 0 1px 0 rgba(255,255,255,0.06), 0 0 30px rgba(100,190,255,0.12)",
          },
          "100%": {
            backgroundColor: "rgba(255,255,255,0.06)",
            boxShadow:
              "0 1px 4px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06)",
          },
        },
      },
      animation: {
        "mobile-toolbar-flash": "mobile-toolbar-flash 420ms ease-out forwards",
        // A feed entry arriving after the initial render (see ChatFeed).
        "chat-enter": "chat-enter 200ms ease-out both",
        "harness-row": "harness-row 180ms ease-out both",
        "harness-msg": "harness-msg 220ms ease-out both",
        "harness-pop": "harness-pop 260ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
      },
    },
  },
  plugins: [typography, pointerCoarse],
} satisfies Config;
