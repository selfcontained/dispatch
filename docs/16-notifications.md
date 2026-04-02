# Notifications

## Overview

Dispatch sends Slack notifications when agents need attention, so you don't have to watch the dashboard. Notifications are event-driven and focus-aware — you only get notified about agents you're not actively viewing.

## Slack Setup

1. Create a Slack incoming webhook for your target channel (see [Slack docs](https://api.slack.com/messaging/webhooks)).
2. In Dispatch, go to **Settings → Notifications**.
3. Paste the webhook URL.
4. Use **Send test** to verify the integration.

## Configurable Events

You can enable or disable notifications for each event type:

| Event | Default | Description |
|-------|---------|-------------|
| `done` | Enabled | Agent finished its task |
| `waiting_user` | Enabled | Agent needs your input or a decision |
| `blocked` | Disabled | Agent hit an error it can't resolve |

## Focus-Aware Suppression

Dispatch tracks whether you're actively viewing an agent's terminal. When you have an agent's terminal open in the browser, notifications for that agent are suppressed — the assumption is you already know what's happening.

Focus tracking uses a 30-second TTL. If you switch away from an agent for more than 30 seconds, notifications resume for that agent.

## Message Format

Slack messages include:
- Agent name and status emoji (green for done, yellow for waiting, red for blocked)
- The event message from the agent
- Color-coded attachment matching the event type

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/notifications/settings` | Get webhook URL and enabled events |
| POST | `/api/v1/notifications/settings` | Update webhook URL and event config |
| POST | `/api/v1/notifications/test` | Send test message to configured webhook |

### `POST /api/v1/notifications/settings`

```json
{
  "slackWebhookUrl": "https://hooks.slack.com/services/T.../B.../xxx",
  "events": {
    "done": true,
    "waiting_user": true,
    "blocked": false
  }
}
```
