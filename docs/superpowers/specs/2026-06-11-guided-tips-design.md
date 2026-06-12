# Guided Tips — Feature Discovery System

A lightweight feature discovery system for Dispatch with two surfaces: inline popovers anchored to new features after an upgrade, and an ambient tip bar in the bottom buffer area that shows tips during idle periods.

## Audience

Power users who self-host Dispatch. The system should be respectful of attention, easy to dismiss, and not feel patronizing.

## Architecture

### Unified Tip Registry

A single `tips.ts` file holds all tip definitions as a typed array. Each tip declares:

```ts
type Tip = {
  id: string; // unique, stable identifier (e.g., "quick-phrases")
  title: string; // short heading (e.g., "Quick Phrases")
  body: string; // 1-2 sentence description
  docsPath?: string; // path to in-app docs (renders "Learn more" link)
  since: string; // semver version this feature shipped in (e.g., "0.23.0")
  surfaces: Surface[]; // which surfaces this tip is eligible for
};

type Surface = "inline" | "ambient";
```

- `surfaces` controls where a tip can appear. Most tips are `["inline", "ambient"]`. Tips without a specific UI anchor (general workflow tips) use `["ambient"]` only.
- `since` enables version-gating for inline tips: only show if the user upgraded past this version.

Adding a new tip is a single entry in this registry.

### State Management

Three Jotai atoms persisted to localStorage:

**`tipsEnabledAtom`** — `atomWithLocalStorage("dispatch:tipsEnabled", true)`
Master toggle. When false, `TipSpot` renders children transparently, ambient bar shows nothing. Controlled from both surfaces' "Don't show tips" links and from Settings.

**`dismissedTipsAtom`** — `atomWithLocalStorage<string[]>("dispatch:dismissedTips", [])`
Array of dismissed tip IDs. Shared across both surfaces — dismissing a tip from either surface adds its ID here. The Settings reset button clears this array.

**`lastSeenVersionAtom`** — `atomWithLocalStorage<string | null>("dispatch:lastSeenVersion", null)`
The app version from the user's previous session. On app load, tips with `since` between `lastSeenVersion` and the current version are candidates for inline display. After comparison, update to the current version. First-time users (`null`) get no inline tips — they haven't upgraded, so nothing is "new." They discover features through the ambient bar over time.

### Shared Hook

`useTip(id: string)` is the hook both surfaces use. It reads from the registry and state atoms, returning:

- `tip` — the tip definition (or null if ID not found)
- `shouldShowInline` — true if the tip is undismissed, tips are enabled, and the tip's version is newer than `lastSeenVersion`
- `shouldShowAmbient` — true if the tip is undismissed, tips are enabled (no version gating for ambient)
- `dismiss()` — adds the tip ID to `dismissedTipsAtom`
- `disableAll()` — sets `tipsEnabledAtom` to false

## Surface 1: Inline Popover (TipSpot)

### Usage

Wrap the target element with a `TipSpot` component at the usage site:

```tsx
<TipSpot tipId="quick-phrases" side="bottom" align="start">
  <QuickPhrasesButton />
</TipSpot>
```

When the tip should not show (already dismissed, tips disabled, version not applicable), `TipSpot` renders its child transparently with zero overhead.

### Behavior

- **Auto-open on mount** after a ~500ms delay so the UI has settled.
- **One at a time** — a `TipQueueProvider` context ensures only one popover is open. First eligible tip in mount order wins; others wait until it's dismissed.
- **No sequential tour** — tips are independent. No step counter, no "next" button. If another tip is queued, it appears after the current one is dismissed.

### Popover Content

- Title (bold) with a small accent icon (sparkle or similar)
- Body text (1-2 lines)
- "Learn more →" link to docs (if `docsPath` is set)
- Dismiss `✕` button (top right)
- "Don't show tips" link (bottom right) — disables the entire system

### Dismissal

- Clicking `✕`, clicking outside the popover, or pressing Escape all permanently dismiss the tip.
- "Don't show tips" sets `tipsEnabledAtom` to false, hiding all tips everywhere.

### Styling

Uses the existing Radix Popover component. Glass overlay aesthetic with a subtle purple accent border to distinguish from regular popovers. Fade + scale entrance animation matching the existing popover pattern (zoom-in-95, ~200ms, ease-out).

## Surface 2: Ambient Tip Bar

### Placement

The existing bottom buffer zone below the terminal area. A single subtle line of text.

### Idle Detection & Display Logic

1. An inactivity timer starts when there is no keyboard/mouse activity. Agent activity is not considered — tips can appear while an agent is running, since that's often when users are idle and waiting.
2. After a base delay (~2-3 minutes of inactivity), a random roll determines whether to show a tip (~40% chance).
3. If the roll fails, reset and wait another interval.
4. If the roll succeeds, pick a random undismissed tip eligible for the ambient surface. Avoid repeating the same tip within the same browser session (tracked in memory, not localStorage).
5. The tip fades in gently.

### Auto-Hide Timer

Once visible, a 30-second countdown begins:

- If the user hovers over the tip bar, the countdown pauses.
- When the user moves away, the countdown resumes.
- When the countdown expires, the tip fades out quietly.
- The tip is **not** dismissed on auto-hide — it returns to the pool and could appear in a future idle period.
- Only clicking `✕` permanently dismisses the tip.

### Content Layout

A single line:

```
💡 Personas — Launch specialized review agents with structured feedback.  Learn more →  ·  Don't show tips  ✕
```

- Lightbulb icon (subtle opacity)
- Feature name (slightly brighter weight)
- Short description
- "Learn more →" link to docs
- "Don't show tips" link — disables the entire system
- Dismiss `✕` — permanently dismisses this specific tip

### Styling

Subtle top border separator. Very low-contrast background (nearly transparent). Text at reduced opacity. The bar should feel ambient, not attention-grabbing.

## Settings Integration

In the existing Notifications settings section, add:

- **"Show tips" toggle** — controls `tipsEnabledAtom`. When off, no inline popovers auto-open and the ambient bar never shows tips.
- **"Reset dismissed tips" button** — clears the `dismissedTipsAtom` array. Shows a confirmation toast ("Tips reset — you'll see them again as you use the app").

## File Structure

```
apps/web/src/
├── lib/
│   └── tips/
│       ├── tips.ts              # tip registry (array of tip definitions)
│       ├── tips-state.ts        # Jotai atoms: tipsEnabled, dismissedTips, lastSeenVersion
│       └── use-tip.ts           # hook: useTip(id) → { tip, shouldShowInline, shouldShowAmbient, dismiss, disableAll }
├── components/
│   └── tips/
│       ├── tip-spot.tsx         # <TipSpot> wrapper component (inline popover)
│       ├── tip-popover.tsx      # popover content (title, body, learn more, dismiss, don't show)
│       ├── ambient-tip-bar.tsx  # bottom bar with idle detection + auto-hide timer
│       └── tip-queue-provider.tsx  # context that ensures one inline popover at a time
```

- `TipQueueProvider` wraps the app layout and coordinates which `TipSpot` gets to open its popover.
- `AmbientTipBar` lives in the layout near the bottom buffer. It handles idle detection, random roll, hover-pause timer, and tip selection.
- Settings controls go in the existing notifications settings component.

## Testing Strategy

- **Unit tests** for `useTip` hook: version comparison logic, dismissal state, enable/disable.
- **Unit tests** for idle detection and timer logic in the ambient bar (mock timers).
- **E2E test** for inline popover: wrap a test element with `TipSpot`, verify popover appears and can be dismissed.
- **E2E test** for ambient bar: trigger idle conditions, verify tip appears and auto-hides.
- **E2E test** for settings: toggle tips off, verify neither surface shows. Reset tips, verify they reappear.

## Starter Tips

The initial registry should ship with a handful of tips for existing features to validate the system:

- Quick Phrases
- Personas
- Brain (shared memory)
- Job scheduler
- Media sidebar

These all have existing docs pages and clear UI anchors. New tips get added as part of the feature development process — one registry entry plus a `TipSpot` wrapper at the usage site.
