# Manual notification validation

From this checkout, on the logged-in Mac desktop:

```sh
python3 scripts/verify-macos-notifications.py
```

This compiles the shipping `UpdateNotifier.swift` into a separate **Dispatch Notification Test.app**, signed ad hoc with App Sandbox enabled. Its bundle ID is `dev.bradharris.dispatch.notification-validation`. It links no Dispatch service, database, recovery, update-installation, or `AppPaths` code. The sandbox grants no home-directory access, including `~/.dispatch-mac`. It never launches or changes the installed Dispatch app. No SDK download or VM is required.

The bell menu is labeled **Dispatch Test**. Each Send action waits five seconds so you can switch to another app and keep typing. Allow notifications for **Dispatch Notification Test** when macOS asks. This initial OS permission prompt is expected; subsequent messages must not activate the test app or show a dialog.

1. Send Verification failed, Preparation changed, Agents busy, and Retries exhausted separately. Confirm the title is **Update postponed** and each body matches the selected reason. Capture a banner or Notification Center screenshot for each.
2. Send Repeat postponement twice. Open Notification Center: only the latest postponement should remain for this test app, with the latest repeat number. Capture it.
3. Send Update completed. Confirm a separate completed notification can coexist with the latest postponement.
4. Click a test notification. Confirm the **Dispatch Test** menu opens; the log records `notification clicked: opening menu`.
5. Send Simulate unavailable delivery. Switch away before it fires: no window or focus change should occur. Open the test menu and capture the retained title/body fallback. This injects delivery failure through the shipping notifier's real fallback branch; it does not change system settings. Optionally deny this test app notifications in System Settings and repeat a normal Send action to exercise actual denied permission.

The log is `/tmp/dispatch-notification-validation-<uid>/events.log`. Each send records frontmost bundle IDs before/after and visible window count. First authorization can change focus; grant it, then repeat to measure normal delivery. A `loginwindow` result indicates the command was run outside the desktop session and cannot establish live focus behavior. This harness validates the shipping notification transport and equivalent menu click/fallback callbacks, not real agent activity or Sparkle installation. The Swift regression tests cover updater routing separately.

Cleanup from the same checkout:

```sh
python3 scripts/verify-macos-notifications.py --cleanup
```

This stops only the verified test executable, clears notifications belonging to the separate test bundle, and removes its temporary app/log/build files. macOS may retain its separate notification permission/container record; production state is untouched. Save screenshots/logs before cleanup.
