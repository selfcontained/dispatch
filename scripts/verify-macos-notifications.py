#!/usr/bin/env python3
"""Build/run an App Sandbox notification-only dev app, or remove its temporary files.
No Dispatch service, updater, database, or production data code is linked.
"""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cleanup', action='store_true')
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
root = Path('/tmp') / f'dispatch-notification-validation-{os.getuid()}'
marker = root / 'validation-owned'
app = root / 'Dispatch Notification Test.app'
executable = app / 'Contents/MacOS/NotificationTest'
identifier = 'dev.bradharris.dispatch.notification-validation'

if root.exists():
    if root.is_symlink() or not marker.is_file() or marker.read_text() != identifier:
        raise SystemExit(f'Refusing to modify unrecognized directory: {root}')
    pid_file = root / 'pid'
    if pid_file.exists():
        pid = int(pid_file.read_text())
        command = subprocess.run(['ps', '-p', str(pid), '-o', 'comm='], capture_output=True, text=True).stdout.strip()
        if command == str(executable):
            os.kill(pid, signal.SIGTERM)
    if args.cleanup and executable.is_file():
        subprocess.run([str(executable), '--clear-notifications'], check=True)
    shutil.rmtree(root)
if args.cleanup:
    print('Removed validation app, log, and its notifications. Its separate macOS notification permission may remain in System Settings.')
    raise SystemExit(0)

root.mkdir(mode=0o700)
marker.write_text(identifier)
(executable.parent).mkdir(parents=True)
info = dict(CFBundleIdentifier=identifier, CFBundleName='Dispatch Notification Test',
            CFBundleDisplayName='Dispatch Notification Test', CFBundleExecutable='NotificationTest',
            CFBundlePackageType='APPL', CFBundleVersion='1', CFBundleShortVersionString='dev', LSUIElement=True)
with (app / 'Contents/Info.plist').open('wb') as output:
    plistlib.dump(info, output)
entitlements = root / 'sandbox.plist'
with entitlements.open('wb') as output:
    plistlib.dump({'com.apple.security.app-sandbox': True}, output)
subprocess.run(['swiftc', '-parse-as-library',
                str(repo / 'apps/macos/Sources/DispatchMenu/UpdateNotifier.swift'),
                str(repo / 'scripts/fixtures/NotificationValidation.swift'), '-o', str(executable)], check=True)
subprocess.run(['codesign', '--force', '--sign', '-', '--entitlements', str(entitlements), str(app)], check=True)
subprocess.run(['codesign', '--verify', '--strict', str(app)], check=True)
with (root / 'events.log').open('w') as log:
    process = subprocess.Popen([str(executable)], stdout=log, stderr=log)
(root / 'pid').write_text(str(process.pid))
time.sleep(1)
if process.poll() is not None:
    raise SystemExit(f'Validation app failed to launch. See {root / "events.log"}')
print(f'Launched sandboxed {app}\nLog: {root / "events.log"}')
print('Use the bell menu “Dispatch Test”. Choose a message, then switch to another app within five seconds.')
print('Allow notifications for Dispatch Notification Test if asked. Click its notification: the test menu should open.')
print('Send another postponement: Notification Center should retain only the latest postponement. Completed is a separate kind.')
print('Use Simulate unavailable delivery to inspect the nonactivating menu fallback. See docs/macos-notification-validation.md.')
