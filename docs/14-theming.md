# Theming

Dispatch supports multiple color themes. Themes are defined as sets of CSS custom properties and can be switched at runtime via the Settings > Appearance picker. The user's choice persists in `localStorage` and is applied before React mounts to avoid a flash of wrong colors.

## Architecture overview

```
web/src/index.css          ← Theme CSS variable definitions (:root + [data-theme="..."])
web/tailwind.config.ts     ← Maps CSS vars to Tailwind color utilities
web/src/hooks/use-theme.ts ← React hook + theme registry (ThemeId, THEMES array)
web/src/components/app/settings-pane.tsx ← Appearance UI (theme picker)
web/index.html             ← Inline script for flash-free theme on load
```

## CSS custom properties

All theme colors live in `web/src/index.css`. The default theme is defined on `:root`. Additional themes use `[data-theme="<id>"]` selectors.

### Base tokens (shadcn/ui standard)

These are the standard shadcn tokens. Every theme must define all of them:

| Variable | Purpose |
|---|---|
| `--background` | Page background |
| `--foreground` | Default text color |
| `--card` / `--card-foreground` | Card surfaces |
| `--popover` / `--popover-foreground` | Popover/dropdown surfaces |
| `--primary` / `--primary-foreground` | Primary action color (buttons, links) |
| `--muted` / `--muted-foreground` | Muted/secondary surfaces and text |
| `--accent` / `--accent-foreground` | Accent highlight |
| `--destructive` / `--destructive-foreground` | Destructive/error actions |
| `--border` | Border color |
| `--input` | Input field border |
| `--ring` | Focus ring color |

### Status tokens

These control agent state indicators, badges, buttons, and status dots throughout the UI:

| Variable | Purpose | Default theme | Example usage |
|---|---|---|---|
| `--status-working` | Active/success state | Emerald | Agent working indicator, "running" badge, service OK dot |
| `--status-blocked` | Error/blocked state | Red | Agent blocked, error badge, live stream indicator |
| `--status-waiting` | Warning/pending state | Amber | Waiting for user, reconnect indicator, full-access warning |
| `--status-done` | Info/complete state | Sky blue | Agent done, transitional badge, info buttons |
| `--status-idle` | Neutral/idle state | Zinc gray | Idle agent border |

### Surface tokens

| Variable | Purpose |
|---|---|
| `--surface` | Header, footer, and toolbar background (slightly darker than `--background`) |
| `--terminal-bg` | Terminal pane and xterm background |

### Value format

All values use **bare HSL components** without the `hsl()` wrapper — this allows Tailwind's opacity modifier syntax to work:

```css
--status-working: 158 64% 52%;   /* ✓ correct */
--status-working: hsl(158, 64%, 52%);  /* ✗ wrong — breaks Tailwind opacity */
```

## Tailwind integration

`web/tailwind.config.ts` maps CSS vars to Tailwind utilities. The status colors use `<alpha-value>` for opacity support:

```ts
status: {
  working: "hsl(var(--status-working) / <alpha-value>)",
  blocked: "hsl(var(--status-blocked) / <alpha-value>)",
  waiting: "hsl(var(--status-waiting) / <alpha-value>)",
  done:    "hsl(var(--status-done) / <alpha-value>)",
  idle:    "hsl(var(--status-idle) / <alpha-value>)",
}
```

This means you can use standard Tailwind patterns:

```tsx
<span className="text-status-working" />           // solid color
<span className="bg-status-working/15" />           // 15% opacity background
<span className="border-status-blocked/50" />       // 50% opacity border
```

The `surface` and `terminal-bg` colors are also available as `bg-surface` and `bg-terminal-bg`.

## How to add a new theme

### Step 1: Define the CSS variables

Add a new `[data-theme="your-theme-id"]` block in `web/src/index.css`. You must define **every** variable listed above. Copy an existing theme block as a starting point:

```css
[data-theme="midnight"] {
  /* Base tokens */
  --background: 240 20% 4%;
  --foreground: 0 0% 95%;
  --card: 240 18% 7%;
  --card-foreground: 0 0% 95%;
  --popover: 240 18% 7%;
  --popover-foreground: 0 0% 95%;
  --primary: 270 80% 60%;
  --primary-foreground: 240 20% 4%;
  --muted: 240 12% 12%;
  --muted-foreground: 240 8% 60%;
  --accent: 240 12% 12%;
  --accent-foreground: 0 0% 95%;
  --destructive: 0 80% 55%;
  --destructive-foreground: 0 0% 98%;
  --border: 240 10% 18%;
  --input: 240 10% 18%;
  --ring: 270 80% 60%;

  /* Status tokens */
  --status-working: 140 60% 50%;
  --status-blocked: 0 80% 55%;
  --status-waiting: 50 90% 60%;
  --status-done: 210 90% 60%;
  --status-idle: 240 5% 45%;

  /* Surface tokens */
  --surface: 240 20% 3%;
  --terminal-bg: 240 20% 3%;
}
```

### Step 2: Register the theme in use-theme.ts

1. Add the new ID to the `ThemeId` union type:

```ts
export type ThemeId = "default" | "crumbstream" | "midnight";
```

2. Add an entry to the `THEMES` array with a label, description, and 4 representative hex swatches (shown in the picker UI):

```ts
{
  id: "midnight",
  label: "Midnight",
  description: "Deep purple with violet accents",
  swatches: ["#0a0a14", "#9966ff", "#f0f0f0", "#2d2d3d"],
},
```

That's it — the theme picker, localStorage persistence, and flash-free loading all work automatically.

### Step 3: Validate

1. Run `npm run finalize:web` to verify the build compiles.
2. Start a dev server and visually check: sidebar, status footer, badges, buttons, terminal pane, settings pane, and the create-agent dialog.
3. Run `npm run test:e2e` to confirm no regressions.

## Color design tips

- **Background** should be very dark (lightness 4–8%). The `--surface` should be slightly darker than `--background` for the header/footer strip.
- **Primary** is the most prominent accent — used on the Create button, selected states, and focus rings. Pick something that pops against the background.
- **Status colors** should be visually distinct from each other. They appear as small dots and text labels, so they need good contrast against both `--background` and `--card`.
- **Border** should be subtle — lightness around 18–22% works well for dark themes.
- **Terminal background** (`--terminal-bg`) is usually the same as `--background` or `--surface`. The terminal ANSI palette (red, green, blue, etc.) is currently hardcoded to a Monokai-inspired set and shared across themes — only the terminal `background` and `foreground` colors are theme-aware.

## What NOT to do

- **Don't use hardcoded Tailwind color classes** like `text-emerald-400` or `bg-red-500` for anything that should change with the theme. Use the semantic `status-*` utilities or the base tokens (`primary`, `destructive`, etc.) instead.
- **Don't use hardcoded hex values** for backgrounds like `bg-[#141414]`. Use `bg-terminal-bg`, `bg-surface`, or `bg-background`.
- **Don't wrap CSS var values in `hsl()`** — the bare `H S% L%` format is required for Tailwind opacity support.
- **Don't forget to define all variables** — a missing variable will cause that color to disappear (transparent) in your theme.

## File reference

| File | What to edit |
|---|---|
| `web/src/index.css` | Add `[data-theme="..."]` CSS variable block |
| `web/src/hooks/use-theme.ts` | Add to `ThemeId` type and `THEMES` array |
| `web/tailwind.config.ts` | Only if adding new semantic color tokens (rarely needed) |
| `web/src/components/app/settings-pane.tsx` | Only if changing the picker UI itself |
| `web/index.html` | Only if changing the flash-prevention script |
