# Settings audit

September 2026. Scope: application settings, persisted UI preferences, launch
settings, settings API consumers, contextual controls, help, and tips.

## Removed

- **Short startup rules** was an implementation variant rather than an end-user
  preference. Keep the complete rules for ordinary sessions so plugin-free
  installations retain UI validation, pull-request, and persona-review guidance.
  Remove its checkbox, API, database reader/writer, launch plumbing, alternate
  rules, and promotional tip. A migration deletes its stored value. Job-specific
  lifecycle instructions remain distinct because jobs have a different protocol.
- Removed the unused toggle-card component, its tests, and the optimistic boolean
  settings hook after confirming they have no remaining consumers.

No other live rollout switches were found in the audited settings. Compatibility
parsers and old-route redirects serve existing stored data or links, so they are
not feature flags and remain.

- Removed full-history rendering by user request: the appearance setting, stored
  preference reader, and Cmd/Ctrl+F expansion in both streams and threads. Long
  conversations remain windowed, including when a browser has the old preference
  saved. Native browser Find only searches currently rendered content.

## Organization

General stays first; regular menu entries are alphabetical. Admin-only Releases
stays at the bottom. Within Agents, agent types precede Personalities.

| Section       | Responsibility                                                |
| ------------- | ------------------------------------------------------------- |
| General       | Instance name, user avatar, theme, icon color                 |
| Agents        | Personalities and available agent runtimes                    |
| Workspace     | Editors and worktree location                                 |
| Connections   | Browser extension setup and pairing                           |
| Notifications | Browser, Slack, sound, and event preferences                  |
| Security      | Password and sign-out                                         |
| Resources     | Resource collection consent and diagnostic charts             |
| Updates       | Dispatch version/channel/update policy and CLI plugin updates |
| Releases      | Release administration, visible only to administrators        |
| Help          | Product documentation                                         |

Editors and worktrees move out of Agents. Plugin updates move to Updates. Security
gets a direct destination instead of sitting below the theme picker. Existing
section URLs remain valid; the editor enablement link and affected help text point
to the new destinations.

## Kept deliberately

- Resource collection: controls background sampling and in-memory history.
- Agent runtimes, editor selection, personality, worktree placement: user workflow.
- Notification channels, events, sounds: attention and delivery preferences.
- Release channel and automatic update policy: operational choices.
- Passwords, pairing, tokens: authentication and authorization, not rollout flags.
- Model selection, archive retention, job scheduling/webhooks/continuation: real
  runtime or data-lifecycle configuration.
- Contextual diff filters, split panes, drawers, child-message filters, launch
  defaults, drafts, and dismissal state stay beside the feature they affect;
  moving them all into global Settings would add duplication and clutter.

## Message identity

User messages use a neutral wash across dark and light themes. General settings
provides six built-in user avatars, photo upload, and reset. The avatar is stored
per instance and used in streams, threads, and reply indicators. Browser uploads
accept PNG/JPEG/WebP/HEIC/HEIF up to 50 MB and 64 megapixels and are
framed in a circular crop preview with drag/keyboard positioning, zoom, reset,
and cancel, then resized to 256 × 256 before saving. HEIC conversion loads on demand when
native browser decoding fails. Only small PNG/JPEG/WebP data URLs
are accepted by the server.

Safari canvas JPEGs carry EXIF metadata even after resizing. Avatar validation
accepts it because rotation cannot change the dimensions of a square image;
ordinary attachment dimension detection retains its conservative EXIF handling.
