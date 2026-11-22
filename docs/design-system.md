# Dispatch design system

The rules new UI is built against and audited against. One rule per id; ids are stable so audits, tasks and reviews can cite them (`F1`, `C4`, `T2`).

- **Stack:** Tailwind and shadcn/ui. Tokens are values in `apps/web/tailwind.config.ts` and the CSS variables in `apps/web/src/index.css`, used through ordinary Tailwind classes. Shared components live in `apps/web/src/components/ui`. Theme mechanics are in [14-theming.md](14-theming.md).
- **Status of these rules:** they are the target. They came from the November 2026 audit, and existing code is still being migrated by the board tasks labelled `design-system`. New and changed UI follows them now; older UI is not a precedent.
- **Changing a rule:** edit this file in the same PR as the token or component change that needs it, and add a line to the change log at the bottom. The `design-system-auditor` persona proposes changes; a person approves them.
- **Precedence:** a rule here wins over a pattern found in existing code. `CLAUDE.md` and the user's instructions win over this file.

## Foundations and tokens

### F1 — Type ramp

Registered in `tailwind.config.ts` `fontSize` with paired line-height: `label-xs` 10/14, `label-sm` 11/16, `body-sm` 12/16, `body-md` 14/20, `body-lg` 16/24, `heading-sm` 14/20 semibold, `heading-md` 16/24 semibold, `heading-lg` 20/28 semibold, `display` 24/32 semibold. `body-lg` is for touch inputs (16px stops iOS zooming) and glyph-only controls. `code` (0.875em) is for inline code, which scales with its paragraph. No other sizes. Weights: 400, 500, 600 only.

### F2 — Eyebrow (uppercase section) labels

One `section-label` class: `label-xs`, medium, `tracking-wider`, `text-muted-foreground`, uppercase. A future `<SectionLabel>` component wraps that class. No other uppercase text except Badge.

### F3 — Headings

Page title = `heading-lg`. Dialog / drawer / card title = `heading-md`. Section title = `heading-sm`. Group label = `SectionLabel`. Heading level follows document outline, never chosen for its size.

### F4 — Radius

`xs` (4px) — boxes of 20px or less, such as checkboxes and seat chips, which `sm` would turn into circles. `sm` — badges, menu items, inline chips. `md` — buttons, inputs, popovers, list rows. `lg` — cards, board columns, panels. `xl` — dialogs and sheets only. `full` — pills, avatars, dots. `mark` (2px) — chart marks only. `screen` (28px) — controls that follow a phone’s bottom corners. Bare `rounded` is banned (→ `sm`).

### F5 — Raw palette colors

No raw palette classes and no colour literals in classes. amber/yellow/orange → `warning`; green/emerald → `success`; red/rose → `danger`; blue/sky → `info`; violet/purple → `status-merged`; categorical colors (brain event types) → `chart-1…6`; agent identity → `seat-1…10`. Hex appears only where a colour is data (user-picked colours, avatars, terminal palettes) or canvas paint. The `dispatch/design-tokens` ESLint rule (`apps/web/eslint-design-tokens.js`) enforces F1, F4, F5, F7, F8 and the z steps of F10; an exception names one file and one class in `eslint.config.js`.

### F6 — Intent colors vs status colors

`--success`, `--warning`, `--danger`, `--info` alias the status vars, so there is one value per theme. `danger` is hue 0 in every theme and replaces `destructive`. Each intent has an `-ink` step for small text that needs more contrast on light surfaces. `status-*` is reserved for rendering an agent, task or run state; everything else uses intents.

### F7 — Elevation / glass

Elevation is CSS variables per theme mode, exposed as `surface-inset`, `surface-panel`, `surface-raised` and `surface-overlay` classes. Their parts are tokens too: `shadow-elev-*`, `edge` / `edge-subtle` / `edge-strong`, `fill-inset` / `fill-raised` / `fill-hover` / `fill-track`. Scrims use `scrim`. What sits on an image or video backdrop uses `media` / `media-foreground`; toolbars over it use `surface-overlay` with `overlay-foreground`. `white`, `black` and `shadow-[…]` classes are banned.

### F8 — Alpha ladders on semantic colors

Fills: `surface-subtle` (= muted/30), `surface-hover` (= muted/60), `surface-selected` (= primary/10). Borders: `border` and `border-subtle` (= /60). Text: `foreground`, `muted-foreground`, `text-faint` (= muted-foreground/70). Any other alpha is a named step: `wash` 5, `tint` 10, `tint-strong` 18, `line` 30, `line-strong` 50, `veil` 60, `soft` 80, `dense` 92 (`bg-danger/tint`). Tinted intent surface is one recipe: `tint` fill, `line` border, solid text.

### F9 — Spacing

Allowed steps: 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12 (2/4/6/8/12/16/24/32/48px). `2.5`→2 or 3, `5`→4 or 6, `7`→6 or 8; `pl-5` stays only where text lines up under a 12px glyph and its `gap-2`. Safe-area padding uses `pt-safe`, `pr-safe`, `pb-safe`, `pl-safe`, each with an optional minimum step (`pb-safe-2`).

### F10 — Focus, disabled, z-index

One `focus-ring` (`focus-visible` only, 2px `ring`, no offset) and `focus-ring-inset` for rows whose container would clip it. Disabled is `disabled-state` (`opacity-50` + no pointer events); add `disabled:pointer-events-auto` only where a disabled control explains itself on hover. Named z steps: `sticky` 10, `raised` 20, `dock` 30, `drawer` 50, `drawer-panel` 60, `modal` 70, `popover` 80, `toast` 85, `tooltip` 90, `progress` 100, and `viewer` 120 to `viewer-menu` 150 for the image viewer, which opens over dialogs.

### F11 — Syntax highlighting and fonts

One `--syntax-*` token set consumed by both highlighters. Split `--font-ui` and `--font-mono` (both may stay JetBrains Mono).

## Components

### C1 — Button

Sizes `xs` 28 / `sm` 32 / `md` 36 and `icon-xs` 24 / `icon-sm` 28 / `icon-md` 32. Touch sizing lives in the primitive via the existing `pointer-coarse:` variant (min 44px) — never `h-11` at the call site. Variants: `primary`, `secondary` (today's default), `ghost`, `danger`, plus `ghost` + `tone`. Drop `success`. Height classes on `<Button>` are lint errors.

### C2 — Raw `<button>`

Clickable rows use a `RowButton` primitive (full-width, `md` radius, `surface-hover`, `focus-ring-inset`); everything else is `Button`. Raw `<button>` only inside `components/ui`.

### C3 — Badges, pills, status dots

One `Badge`: `tone` (neutral / success / warning / danger / info / merged) × `appearance` (tint / outline) × `size` (sm / md), optional leading icon or dot. Sentence case by default. One `StatusDot` (8px; 6px in dense rows). A status renders the same way wherever it appears; tables may use dot + text, never colored text alone.

### C4 — Dialogs

`DialogContent size="sm|md|lg|xl"` (400 / 560 / 720 / 960), `p-5`, radius `xl`, built-in close button top-right (`icon-sm` ghost, `aria-label="Close"`). `DialogFooter`: right-aligned, Cancel (ghost) then primary, `gap-2`; a top divider appears only when the body scrolls. Tertiary/destructive action sits left.

### C5 — Form fields and setting rows

`Field` (label `body-sm` medium, control, hint `body-sm` muted, error `body-sm` danger). `SettingRow` (label + description left, control right). `OptionCard` (radio/checkbox card). All controls 36px in forms, 32px in toolbars.

### C6 — Selects and pickers

Fixed options → `Select`. Searchable or async → one `Combobox` (Command in Popover). Composer pickers share one `PickerList`. Highlighted item is always `surface-hover`; selected shows a check.

### C7 — Tabs and view switches

Two patterns only. `SegmentedControl` — switches the view of the same data, ≤4 options, 32px. `Tabs` (underline) — switches content sections within a pane. Both URL-backed.

### C8 — Cards and panels

`Card` = raised surface, radius `lg`, `p-4`. `Panel` = flat grouped region, `border-subtle` + `surface-subtle`, radius `lg`, `p-3`. No box inside a box of the same level.

### C9 — Tooltips

`IconButton` requires `label`, which sets `aria-label` and renders `Tooltip`. `title=` is allowed only on truncated text.

### C10 — Icons

`icon-sm` 12 (badges, meta), `icon-md` 14 (buttons, rows — default), `icon-lg` 16 (navigation, headers). `size-*` syntax only.

### C11 — Loading and empty states

First load of a list or pane → `Skeleton` shaped like the content. In-flight action → one `Spinner` inside the triggering button, which stays the same width. No bare "Loading…" as a pane's only content. `EmptyState`: optional icon, `heading-sm` title, one muted sentence, at most one action, vertically centered. Empty list inside a populated screen: one muted `body-sm` line.

### C12 — Time and number formatting

One `lib/time.ts`: `relative()` ("9m ago" / "in 50m"), `relativeCompact()` ("9m" — cards only), `absolute()` ("Nov 21, 9:22 PM"), `duration()`. Every relative time carries the absolute time in a tooltip.

### C13 — Stream block shells

One `BlockShell` with three levels. _Plain_ — text, checklist, attachments: no frame. _Card_ — metric, chart, file, resource, code: `Panel` surface, radius `lg`. _Ask_ — question, form, review, permission: `Panel` + a 2px left bar whose color is the block's state (info = waiting on you, neutral = closed, danger = changes requested, success = approved). No top bars. Selection is a background wash only.

### C14 — In-stream controls

Stream blocks use the same `Button`, `Field`, `Checkbox` and `Select` as dialogs, at the dense size (28px). Question options are `Button variant="secondary" size="xs"`; the block's primary action is `primary`; cancel is `ghost`. Form layout is label-top below 640px block width, label-left above. Markdown task lists render with the app `Checkbox` (read-only).

### C15 — Stream meta, chips and counters

All of these are `Badge` (C3): neutral outline for meta, `info` solid for unread counts, tone-mapped for review state, sentence case. One `CountBubble` for numeric badges. Delivery failure is an inline `Alert` (danger, compact) with a `ghost` Retry button.

### C16 — Markdown rendering

One `Markdown` component with two densities (`comfortable` for stream and docs, `compact` for drawers and cards) and no per-surface color overrides. Markdown h1 never exceeds `heading-md` inside a stream, drawer or thread. Blockquote = left rule + muted text, no added quotes.

### C17 — Task surfaces

View switches use `SegmentedControl` (C7), never solid primary. Drawer footer: destructive action left as `ghost` danger, safe actions right. One `AgentChip` (avatar, name, status dot) at two sizes. Capacity uses `warning` tint at full, neutral otherwise. Chips truncate with ellipsis at a max width and never wrap. Agent references always resolve to a name.

### C18 — Segmented controls and tab bars (inventory)

As C7 — `Tabs` (underline, sentence case, optional icon) for sections of a page, `SegmentedControl` (subtle, selected = raised surface) for switching a view or a binary choice. Nothing else sits in a tab row; status belongs in the page header.

### C19 — Sidebar agent card actions

`IconButton` ghost, `icon-sm`, neutral; only a destructive action takes a tone, and only on hover. Overflow into a menu after three.

## Layout and density

### L1 — Page shell and headers

`PageHeader` on every route: title (`heading-lg`) + context left, filters and actions right, fixed 56px. Two content modes: `contained` (max 960px, centered — dashboards, settings, forms) and `full` (boards, chat, diffs). Settings moves to `contained`.

### L2 — Sidebar structure

Fixed order: section switch (if any) → scope selector → one primary "New <thing>" action (same size and position) → list or nav. Section title appears in `PageHeader`, not as a sidebar eyebrow.

### L3 — Dashboard sections and charts

Chart section title = `heading-sm`, sentence case, range as muted suffix. All series colors from `chart-1…6` via `ui/chart`; one `Legend`; one `Meter` for horizontal ratio bars. A color means the same series across a page.

### L4 — Control density

Three densities — inline/dense 28, toolbar 32, form 36 — never mixed in one row. 40px is removed. 44px comes only from `pointer-coarse`.

### L5 — Mobile

Touch targets from primitives (C1). Stat grids are 2 columns below `sm`. Safe-area utilities from F9. Every `contained` page uses a 16px gutter on mobile.

### L6 — Settings pages

Every Settings page: `PageHeader` title + one-line description, `contained` width, sections as `SectionLabel` + `SettingRow`s. An on/off setting that applies immediately is a `Switch`; `Checkbox` is for multi-select lists and forms with a Save.

### L7 — Dialog anatomy as built

C4, plus: sentence-case titles in the form "New <thing>" / "Edit <thing>" / "Delete <thing>?"; optional description under the title; no inner card around the whole form; the confirm action is always `primary` (or `danger`).

## Interaction patterns

### I1 — Destructive confirmation

One `ConfirmDialog` built on `AlertDialog`: title names the object, body states the consequence, Cancel has initial focus, the confirm button repeats the verb ("Delete column"). `danger` styling appears only on that button. `window.confirm` is banned. Reversible actions skip the dialog and offer Undo in a toast.

### I2 — Feedback: toast vs banner vs inline

Toast = result of an action the user just took, transient, never the only record of a failure that needs fixing. `Alert` (tone, title, body, optional action) = a condition of the current view that persists until resolved. Field error = `Field` error slot. One danger color (F6).

### I3 — Slide-overs and close behavior

One `Sheet` primitive (right on desktop, bottom on mobile) underneath all of them; feature classes leave the primitive. Close is always top-right, Esc closes the topmost layer, focus returns to the trigger.

### I4 — Action vocabulary and placement

Entry point: "New <thing>". Dialog confirm: verb + object ("Create task", "Save changes", "Delete column"). Settings: toggles and selects save on change with an inline "Saved" tick; free-text and multi-field groups get an explicit Save, disabled until dirty.

### I5 — Loading, error and empty states

One `AsyncBoundary` per data region with four exclusive states. _Loading_ → `Skeleton` in the shape of the content (never text alone, never the empty state). _Error_ → `Alert` (danger): "Couldn't load <thing>." + Retry, raw server message behind a disclosure. _Empty_ → `EmptyState` (C11), shown only after a successful response; "no results" from a filter is a distinct message with a "Clear filters" action. _Ready_. App boot gets the logo, a spinner, and after 10s an explicit failure message with Retry.

### I6 — Mutation feedback

Feedback appears where the action was taken when the changed object stays on screen (icon swap, inline "Saved", block state). A toast is used only when the object leaves the screen (archive, delete, move) and always carries Undo when the action is reversible. Failures always produce an inline `Alert` on the object plus a toast if the object is off screen.

### I7 — Light themes

F7 — elevation and fills come from per-mode variables. Add the three light themes to visual review for any change touching `components/ui`.

## Agent surfaces, Settings and other apps

### A1 — Permission request

A permission request is a stream block in the shared shell. Actions are a Button row: primary "Allow once", secondary "Always", ghost "Reject". Show the command as one code line; put the working directory and raw input behind a disclosure.

### A2 — Failed turn (engine signed out)

Use the shared error Alert with one primary action and one secondary action as Buttons.

### A3 — Activity steps and the Tasks dock

Two ramp steps per row (label and meta). One focus ring everywhere. The dock uses the shared card.

### A4 — Changes toolbar, review mode and diff comments

Button, Textarea and one SplitButton primitive. Sentence case for all titles. Count uses the shared counter.

### A5 — Changes settings popover

The shared SegmentedControl.

### A6 — Drawer tabs and drawer empty states

The shared Tabs component with tablist semantics. One EmptyState layout.

### A7 — Terminal pane

Status uses the shared StatusDot plus label. The warning uses the inline warning style from the feedback rules (I2). Truncated text gets a tooltip (C9).

### A8 — Image viewer and markup

Overlay toolbars use an elevation token, not black/white literals. One control height per toolbar.

### A9 — Settings save behaviour (verified)

Keep auto-save as the one model. One inline status per setting row: a brief "Saved" on success, and one error wording with Retry on failure. This answers the open question in task 6, item 4.

### A10 — Toasts and silent failures

As I2 and I6. A failed destructive confirm shows the error inside the dialog and keeps the action retryable.

### A11 — Browser extension (code only)

The side panel imports the app's token stylesheet (default theme) and font, and uses the same button, field and status styles.

### A12 — Public site

A marketing site may keep its own type scale, but brand colour and logo treatment come from one shared source. Site colours move to variables.

### A13 — Mac app (code only)

No change beyond the single brand green.

## Toasts

### T1 — Two toast designs

One toast card: the attention design. Status toasts use the same card with the type shown by the bar, tile icon and label, not a full colour fill.

### T2 — Position and what toasts cover

One position for every toast: top-right on desktop, top and inset on phones, in one host so the two kinds stack together.

### T3 — Font

Toasts use the app UI font and the type ramp.

### T4 — Colour mapping

Toast types use the intent aliases from F6 (success, info, warning, danger), not agent-status colours. Shadow comes from the elevation token.

### T5 — Duration and stacking

Success and info 4 seconds. Warning and error stay until dismissed, or at least 8 seconds, and are never collapsed behind another toast. At most three visible, expanded by default on phones.

### T6 — Coverage

As I2 and I6: a toast for a completed action whose result is not already visible on screen, and for a failed background action. Inline for field errors. Apply by action type, not by feature.

### T7 — Copy

One pattern: "Couldn’t <do the thing>." as the title, a plain-language reason or next step as the second line, and the server message only behind a "Details" disclosure. Success is "<Thing> <past participle>." All end with a full stop.

### T8 — Actions and close

Toast actions use the shared Button: one primary, one ghost. One update toast at a time. Close is the top-right X with a 44px hit area, as on the attention card.

## Audit log

Newest first. One line per audit: date, scope, commit audited, where the report is.

- 2026-11-22 — whole app, extension, site, Mac app — `9d2c00d45` — baseline audit, revision 4 (report shared in the auditing agent's stream).

## Change log

Newest first. One line per rule added, changed or removed, with the reason.

- 2026-11-22 — F1–F10 updated as their tokens landed: added `body-lg` and `code` (iOS zoom, inline code), `xs`, `mark` and `screen` radii (small boxes turned into circles at `sm`), named alpha and z steps for values already in use, seat and media colours; named the classes and lint rule that implement them.
- 2026-11-22 — all rules added from the baseline audit.
