# Security Model (MVP)

## Threat Model

This service can execute shell commands and provide terminal access, so compromise impact is high.

## Baseline Controls

1. Network boundary
- Expose service only on localhost or private interface.
- Access remotely via Tailscale/VPN only.
- No direct public internet exposure.

2. Authentication
- Require bearer token on all HTTP/WS routes.
- Separate token scopes optional in MVP; full access token acceptable for single-user setup.

3. Authorization
- Single-user model in MVP.
- Optional operator role split in later phases.

4. Input validation
- `cwd` must be absolute path and within allowed roots.
- Reject dangerous shell metacharacters in any user-supplied command args.
- Prefer argument arrays over shell string interpolation.

5. Process hardening
- Run service under dedicated non-admin macOS user where possible.
- Restrict file system access by convention (allowlisted workspace roots).

6. Auditing
- Log lifecycle actions: create/start/stop/delete/attach.
- Include timestamp, remote IP, and agent id.

## Secrets

- Store auth token in environment variable or local secure file with strict permissions.
- Never return full tokens in logs.

## Session Security

- Terminal WS tokens should be short-lived (e.g., 60 seconds issue window, 30 minutes max session).
- Use TLS when traffic leaves local host context.

## Safety Defaults

- Rate-limit agent creation and screenshot endpoints.
- Set max concurrent agents/simulators.
- Enforce server-side idle timeouts for disconnected stale resources.
