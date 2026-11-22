import typography from "@tailwindcss/typography";
import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

const intent = (name: string) => ({
  DEFAULT: token(name),
  ink: token(`${name}-ink`),
});

const seats = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => `${i + 1}`).map((n) => [
    n,
    {
      DEFAULT: token(`seat-${n}`),
      ink: token(`seat-${n}-ink`),
      text: token(`seat-${n}-text`),
    },
  ])
);

/** `pointer-coarse:` — touch-first devices, where tap targets need ≥44px. */
const pointerCoarse = plugin(({ addVariant }) => {
  addVariant("pointer-coarse", "@media (pointer: coarse)");
});

/** `pt-safe`, `pb-safe-2`: a safe-area inset, never less than the step. */
const safeArea = plugin(({ matchUtilities, theme }) => {
  const side = (property: string, inset: string) => (value: string) => ({
    [property]: `max(${value}, ${inset})`,
  });
  matchUtilities(
    {
      "pt-safe": side("paddingTop", "var(--safe-area-top)"),
      "pr-safe": side("paddingRight", "env(safe-area-inset-right, 0px)"),
      "pb-safe": side("paddingBottom", "env(safe-area-inset-bottom, 0px)"),
      "pl-safe": side("paddingLeft", "env(safe-area-inset-left, 0px)"),
    },
    { values: { ...theme("spacing"), DEFAULT: "0px" } }
  );
});

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // The type ramp. Headings carry their weight. body-lg is the 16px step
      // touch inputs need to stop iOS zooming; code scales with its paragraph.
      fontSize: {
        "label-xs": ["0.625rem", "0.875rem"],
        "label-sm": ["0.6875rem", "1rem"],
        "body-sm": ["0.75rem", "1rem"],
        "body-md": ["0.875rem", "1.25rem"],
        "body-lg": ["1rem", "1.5rem"],
        code: "0.875em",
        "heading-sm": [
          "0.875rem",
          { lineHeight: "1.25rem", fontWeight: "600" },
        ],
        "heading-md": ["1rem", { lineHeight: "1.5rem", fontWeight: "600" }],
        "heading-lg": ["1.25rem", { lineHeight: "1.75rem", fontWeight: "600" }],
        display: ["1.5rem", { lineHeight: "2rem", fontWeight: "600" }],
      },
      // One icon size per control size: sm in badges and meta, md in buttons
      // and rows, lg in navigation and headers.
      size: {
        "icon-sm": "0.75rem",
        "icon-md": "0.875rem",
        "icon-lg": "1rem",
      },
      // Named alpha steps for any token colour: bg-danger/tint,
      // border-danger/line. A tinted intent surface is tint fill, line
      // border, solid text; wash is for tinting a whole block.
      opacity: {
        wash: "0.05",
        tint: "0.1",
        "tint-strong": "0.18",
        line: "0.3",
        "line-strong": "0.5",
        veil: "0.6",
        soft: "0.8",
        dense: "0.92",
      },
      textColor: {
        faint: "hsl(var(--muted-foreground) / 0.7)",
        // Red text takes the readable step; fills, borders and rings keep the red.
        danger: { DEFAULT: token("danger-ink") },
        status: { blocked: token("danger-ink") },
      },
      placeholderColor: { faint: "hsl(var(--muted-foreground) / 0.7)" },
      colors: {
        border: {
          DEFAULT: "hsl(var(--border))",
          subtle: "hsl(var(--border) / 0.6)",
        },
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: {
          DEFAULT: "hsl(var(--surface))",
          subtle: "hsl(var(--muted) / 0.3)",
          hover: "hsl(var(--muted) / 0.6)",
          selected: "hsl(var(--primary) / 0.1)",
        },
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
        danger: { ...intent("danger"), foreground: token("danger-foreground") },
        warning: intent("warning"),
        success: intent("success"),
        info: intent("info"),
        seat: { ...seats, foreground: "hsl(0 0% 100% / <alpha-value>)" },
        edge: {
          DEFAULT: "var(--edge)",
          subtle: "var(--edge-subtle)",
          strong: "var(--edge-strong)",
          "on-color": "var(--edge-on-color)",
        },
        fill: {
          inset: "var(--fill-inset)",
          raised: "var(--fill-raised)",
          hover: "var(--fill-hover)",
          track: "var(--fill-track)",
        },
        scrim: "var(--scrim)",
        overlay: {
          DEFAULT: token("overlay"),
          foreground: token("overlay-foreground"),
        },
        media: {
          DEFAULT: token("media"),
          foreground: token("media-foreground"),
        },
        paper: token("paper"),
        terminal: {
          DEFAULT: token("terminal"),
          shell: token("terminal-shell"),
        },
        engine: {
          codex: "hsl(var(--engine-codex) / <alpha-value>)",
          claude: "hsl(var(--engine-claude) / <alpha-value>)",
        },
        status: {
          working: "hsl(var(--status-working) / <alpha-value>)",
          blocked: "hsl(var(--status-blocked) / <alpha-value>)",
          waiting: "hsl(var(--status-waiting) / <alpha-value>)",
          done: "hsl(var(--status-done) / <alpha-value>)",
          merged: "hsl(var(--status-merged) / <alpha-value>)",
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
      boxShadow: {
        "elev-inset": "var(--elev-inset)",
        "elev-track": "var(--elev-track)",
        "elev-panel": "var(--elev-panel)",
        "elev-control": "var(--elev-control)",
        "elev-raised": "var(--elev-raised)",
        "elev-overlay": "var(--elev-overlay)",
        "elev-popover": "var(--elev-popover)",
        "elev-floating": "var(--elev-floating)",
        "elev-primary": "var(--elev-primary)",
        "elev-primary-hover": "var(--elev-primary-hover)",
        "elev-spotlight": "var(--elev-spotlight)",
        "elev-sticky": "var(--elev-sticky)",
        "elev-side": "var(--elev-side)",
        "elev-jump": "var(--elev-jump)",
        "elev-jump-hover": "var(--elev-jump-hover)",
      },
      // xs: boxes of 20px or less (checkboxes, seat chips), which sm would
      // turn into circles. sm: badges, menu items, chips. md: buttons, inputs,
      // popovers, rows. lg: cards, columns, panels. xl: dialogs and sheets.
      // mark: chart marks only. screen: follows a phone's bottom corners.
      borderRadius: {
        mark: "2px",
        xs: "0.25rem",
        sm: "0.45rem",
        md: "0.6rem",
        lg: "0.75rem",
        xl: "0.75rem",
        screen: "28px",
      },
      // One stacking order. The viewer steps sit above every other overlay
      // because the image viewer opens from inside dialogs. Tooltips top
      // them all: the viewer's own controls have them.
      zIndex: {
        sticky: "10",
        raised: "20",
        dock: "30",
        drawer: "50",
        "drawer-panel": "60",
        modal: "70",
        popover: "80",
        toast: "85",
        progress: "100",
        viewer: "120",
        "viewer-modal": "130",
        "viewer-popover": "140",
        "viewer-menu": "150",
        tooltip: "160",
      },
      maxWidth: {
        // The one contained page width, and a comfortable line for prose.
        page: "60rem",
        reading: "48rem",
      },
      keyframes: {
        "sheet-in-right": { from: { transform: "translateX(100%)" } },
        "sheet-in-left": { from: { transform: "translateX(-100%)" } },
        "sheet-in-bottom": { from: { transform: "translateY(100%)" } },
        "sheet-fade-in": { from: { opacity: "0" } },
        // Fade new posts without moving their rendered position. The same
        // animation is used for changing activity labels inside the stream.
        "chat-enter": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        // A turn's message landing once the turn settles.
        "message-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        // The Chat reaction picker, grown from its trigger.
        "reaction-picker-in": {
          from: { opacity: "0", transform: "translateY(4px) scale(0.94)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "reaction-picker-out": {
          from: { opacity: "1", transform: "scale(1)" },
          to: { opacity: "0", transform: "scale(0.96)" },
        },
        // Each emoji in the picker, staggered in after the panel.
        "reaction-emoji-in": {
          from: { opacity: "0", transform: "scale(0.4)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        // The composer's usage popover, opened like a drawer from its chip:
        // the box is revealed from the edge nearest the trigger. The clip
        // rectangle runs well past the box so the glass shadow comes along.
        // `-up` is the popover above its chip (side=top), `-down` below.
        "usage-panel-in-up": {
          "0%": {
            opacity: "0",
            clipPath: "inset(100% -80px -80px -80px)",
            transform: "translateY(6px)",
          },
          "35%": { opacity: "1" },
          "100%": {
            opacity: "1",
            clipPath: "inset(-80px)",
            transform: "translateY(0)",
          },
        },
        "usage-panel-in-down": {
          "0%": {
            opacity: "0",
            clipPath: "inset(-80px -80px 100% -80px)",
            transform: "translateY(-6px)",
          },
          "35%": { opacity: "1" },
          "100%": {
            opacity: "1",
            clipPath: "inset(-80px)",
            transform: "translateY(0)",
          },
        },
        "usage-panel-out-up": {
          from: { opacity: "1", clipPath: "inset(-80px)" },
          to: {
            opacity: "0",
            clipPath: "inset(100% -80px -80px -80px)",
            transform: "translateY(4px)",
          },
        },
        "usage-panel-out-down": {
          from: { opacity: "1", clipPath: "inset(-80px)" },
          to: {
            opacity: "0",
            clipPath: "inset(-80px -80px 100% -80px)",
            transform: "translateY(-4px)",
          },
        },
        "mobile-toolbar-flash": {
          "0%": {
            backgroundColor: "var(--fill-raised)",
            boxShadow: "var(--elev-control)",
          },
          "18%": {
            backgroundColor: "hsl(var(--info) / 0.14)",
            boxShadow:
              "var(--elev-control), inset 0 0 0 1px hsl(var(--info) / 0.22), 0 0 30px hsl(var(--info) / 0.12)",
          },
          "100%": {
            backgroundColor: "var(--fill-raised)",
            boxShadow: "var(--elev-control)",
          },
        },
      },
      animation: {
        "sheet-in-right": "sheet-in-right 300ms cubic-bezier(0.2, 0, 0, 1)",
        "sheet-in-left": "sheet-in-left 300ms cubic-bezier(0.2, 0, 0, 1)",
        "sheet-in-bottom": "sheet-in-bottom 300ms cubic-bezier(0.2, 0, 0, 1)",
        "sheet-fade-in": "sheet-fade-in 300ms ease-out",
        "mobile-toolbar-flash": "mobile-toolbar-flash 420ms ease-out forwards",
        // A feed entry arriving after the initial render (see ChatFeed).
        "chat-enter": "chat-enter 850ms ease-in-out",
        "activity-label": "chat-enter 320ms ease-out",
        "message-in": "message-in 850ms ease-in-out",
        "reaction-picker-in": "reaction-picker-in 160ms ease-out both",
        "reaction-picker-out": "reaction-picker-out 100ms ease-in both",
        // No fill on the way in: once open, the box is unclipped again.
        "usage-panel-in-up":
          "usage-panel-in-up 260ms cubic-bezier(0.2, 0, 0, 1)",
        "usage-panel-in-down":
          "usage-panel-in-down 260ms cubic-bezier(0.2, 0, 0, 1)",
        "usage-panel-out-up": "usage-panel-out-up 140ms ease-in both",
        "usage-panel-out-down": "usage-panel-out-down 140ms ease-in both",
        // A slight overshoot, so each emoji lands with a pop.
        "reaction-emoji-in":
          "reaction-emoji-in 220ms cubic-bezier(0.34, 1.56, 0.64, 1) both",
      },
    },
  },
  plugins: [typography, pointerCoarse, safeArea],
} satisfies Config;
