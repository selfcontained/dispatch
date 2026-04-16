# Agent Detail And Design Lab

## Agent detail direction

The agent detail surface is being split into three clearer responsibilities:

1. Left card

- Identity
- Live state
- Review signal
- Quick session entry

2. Expanded card

- Overview
- Review entry points
- Execution context
- Lifecycle actions

3. Right detail pane

- Dedicated `Feedback` workspace
- Reviewer list
- Findings
- Review summaries
- Feedback actions

## Decisions captured

### Feedback tab visibility

- `Feedback` is conditional.
- It appears once an agent has any review or feedback history.
- It stays available for that agent even when all findings are resolved.
- When present, it becomes the first tab in the right pane.

### Default tab behavior

- No separate auto-switch logic is needed.
- Because `Feedback` becomes the first tab, it is the default visible detail pane for agents with review history.

### Lifecycle actions on the card

- `Pause` and `Archive` are removed from the collapsed card.
- `Resume` may still appear in collapsed state when the agent is paused.
- `Pause` and `Archive` move into expanded state.

### Reviewer session controls

- Reviewer terminal connect and disconnect live only inside the `Feedback` workspace.
- They do not remain on the agent card.

## Why this split

The previous sidebar detail accumulated too many competing jobs in a narrow column:

- status display
- lifecycle control
- execution context
- reviewer dashboard
- findings browser

The new structure keeps discovery on the card while moving dense inspection and action into the right pane.

## Card behavior

### Collapsed card

- Shows agent type icon, name, live status, relative time, latest event.
- Shows review summary only when review history exists or review is active.
- Review summary is clickable and acts as a shortcut into the `Feedback` workspace.

### Expanded card

- Keeps status and latest event readable.
- Shows `Launch Reviewer` and the parent-session dependency state.
- Shows repo, branch, worktree, runtime, and access mode in a quieter context section.
- Holds lower-frequency lifecycle controls.

## Feedback workspace behavior

The `Feedback` tab is the dedicated review surface. It should contain:

- reviewer groups
- review verdict or progress state
- unresolved findings first
- resolved findings second
- review summary access
- reviewer terminal controls
- `WDYT`, `Fix`, `Fixed`, `Ignore`, and `Reopen`

## Mobile requirement

Mobile cannot require multiple pane-navigation steps to reach active feedback.

Preferred interaction:

- tapping the card body focuses the agent
- tapping the review summary opens feedback directly

## Design Lab direction

The Design Lab should no longer be a single-purpose visual comparison page.
It should become a reusable prototype playground for agents and designers.

### Foundation goals

- host mock UI prototypes inside the app
- make theme verification easy
- support viewport presets
- support scenario-driven mock data
- preserve older visual studies as a secondary mode

### First prototype

- Agent detail redesign
- Feedback-in-right-pane model
- Desktop and mobile mock states
- Theme switcher
- Scenario selector

### Future additions

- reusable mock data fixtures
- saved prototype scenarios
- spacing and token overlays
- contrast helpers
- responsive snapshots
- interaction notes
