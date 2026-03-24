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
        "terminal-bg": "hsl(var(--terminal-bg))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))"
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))"
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))"
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))"
        },
        status: {
          working: "hsl(var(--status-working) / <alpha-value>)",
          blocked: "hsl(var(--status-blocked) / <alpha-value>)",
          waiting: "hsl(var(--status-waiting) / <alpha-value>)",
          done: "hsl(var(--status-done) / <alpha-value>)",
          idle: "hsl(var(--status-idle) / <alpha-value>)"
        }
      },
      borderRadius: {
        lg: "0.75rem",
        md: "0.6rem",
        sm: "0.45rem"
      }
    }
  },
  plugins: []
} satisfies Config;
