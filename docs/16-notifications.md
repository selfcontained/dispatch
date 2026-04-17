# Notifications

## Overview

Dispatch can notify you when an agent reaches a notable state (`done`, `waiting_user`, `blocked`) via two channels:

- **In-app browser notifications** — broadcast over the SSE stream (`GET /api/v1/events`) and surfaced by the connected web client as a native browser notification.
- **Slack webhooks** — fallback when no browser client acknowledges within ~3 seconds, or whenever web notifications are disabled.

Notifications are focus-aware — the agent you are actively viewing is suppressed.

## Slack Setup

1. Create a Slack incoming webhook for your target channel (see [Slack docs](https://api.slack.com/messaging/webhooks)).
2. In Dispatch, go to **Settings → Notifications**.
3. Paste the webhook URL.
4. Use **Send test** to verify the integration.

The URL must start with `https://hooks.slack.com/`; other URLs are rejected to prevent SSRF.

## Web Notifications

Web notifications are broadcast over the SSE event stream whenever at least one browser client is connected. The client acknowledges delivery via `POST /api/v1/notifications/ack` with the `notificationId` from the event; a successful ack suppresses the Slack fallback. If no ack arrives within 3 seconds, Dispatch falls back to Slack (assuming Slack is configured and the event type is enabled there).

Web notifications have their own enable toggle and event list, independent of Slack.

## Configurable Events

Each channel has its own list of event types to notify on. Defaults:

| Event          | Slack default | Description                          |
| -------------- | ------------- | ------------------------------------ |
| `done`         | Enabled       | Agent finished its task              |
| `waiting_user` | Enabled       | Agent needs your input or a decision |
| `blocked`      | Disabled      | Agent hit an error it can't resolve  |

## Focus-Aware Suppression

Dispatch tracks whether you're actively viewing an agent's terminal. When you have an agent's terminal open in the browser, notifications for that agent are suppressed — the assumption is you already know what's happening.

Focus tracking uses a 30-second TTL. If you switch away from an agent for more than 30 seconds, notifications resume for that agent.

## Message Format

Slack messages include:

- Agent name and status emoji (green for done, yellow for waiting, red for blocked)
- The event message from the agent
- Color-coded attachment matching the event type

## API Endpoints

| Method | Path                             | Description                                                        |
| ------ | -------------------------------- | ------------------------------------------------------------------ |
| GET    | `/api/v1/notifications/settings` | Get webhook URL, Slack event list, and web notification config     |
| POST   | `/api/v1/notifications/settings` | Update any subset of webhook URL, event lists, or web notify state |
| POST   | `/api/v1/notifications/test`     | Send test message to the configured (or provided) webhook          |
| POST   | `/api/v1/notifications/ack`      | Acknowledge an in-app notification by `notificationId`             |

### `POST /api/v1/notifications/settings`

All fields optional — only provided fields are updated.

```json
{
  "webhookUrl": "https://hooks.slack.com/services/T.../B.../xxx",
  "notifyEvents": ["done", "waiting_user"],
  "webNotifyEnabled": true,
  "webNotifyEvents": ["done", "waiting_user", "blocked"]
}
```

### `POST /api/v1/notifications/ack`

```json
{ "notificationId": "<id from the SSE event>" }
```

Returns `204` whether or not the notification was still pending.
