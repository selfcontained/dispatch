import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";

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
      },
      borderRadius: {
        lg: "0.75rem",
        md: "0.6rem",
        sm: "0.45rem",
      },
      keyframes: {
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
      },
    },
  },
  plugins: [typography],
} satisfies Config;
