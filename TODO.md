# TODO

## Deferred Improvements

- [ ] **Enforce AUTH_TOKEN in API middleware** — token exists in config but no handler validates it. Wire up bearer token check before exposing outside Tailscale.
- [ ] **Switch `launchctl load/unload` to `launchctl bootstrap/bootout`** — deprecated API in `install-launchd` and `uninstall-launchd`. Still works but may break in future macOS.
- [ ] **Add log rotation for `~/.dispatch/logs/dispatch.log`** — currently grows unbounded. Best option is rotating in `dispatch-launchd-wrapper` on restart since launchd holds the fd.
