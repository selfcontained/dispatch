"""Fail-closed cleanup helpers; commands are injected for host-free tests."""
import json
import os
from pathlib import Path
import plistlib
import signal
import time

TLS_CONFIG = '''[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=localhost
[v3]
subjectAltName=DNS:localhost,IP:127.0.0.1
basicConstraints=critical,CA:TRUE
keyUsage=critical,digitalSignature,keyCertSign,cRLSign
extendedKeyUsage=serverAuth
'''

def read_events(path):
    if not path.exists(): return []
    rows = []
    for line in path.read_text().splitlines():
        try:
            row = json.loads(line)
            if isinstance(row, dict): rows.append(row)
        except json.JSONDecodeError:
            # A crash may leave an incomplete append. Never gate cleanup on it.
            continue
    return rows

def assert_restore(rows, runtime, start):
    requested = [e['details'] for e in rows if e.get('build') == '2' and e.get('event') == 'restore-requested']
    acknowledged = [e['details'] for e in rows if e.get('build') == '2' and e.get('event') == 'restore-acknowledged']
    assert requested and acknowledged and requested[-1] == acknowledged[-1], 'Replacement restore was not acknowledged'
    assert runtime.get('requestID', '').lower() == requested[-1].lower(), 'Stale coordinator state'
    assert runtime['phase'] == ('running' if start else 'stopped'), 'Incorrect restored state'
    return {'requestID': requested[-1], 'phase': runtime['phase']}

def cleanup_service(run, app, root, label, uid, kill=os.kill, clock=time.monotonic, sleep=time.sleep):
    # Event parsing and vanished GUI processes cannot prevent native fallback.
    errors = []
    try:
        for pid in {e['pid'] for e in read_events(root/'sparkle-events.jsonl') if isinstance(e.get('pid'), int)}:
            current = run('ps', '-p', str(pid), '-o', 'command=', capture=True, check=False).stdout.strip()
            if current and Path(current).resolve() == (app/'Contents/MacOS/DispatchMenu').resolve():
                try: kill(pid, signal.SIGTERM)
                except ProcessLookupError: pass
    except Exception as exc: errors.append(str(exc))
    def clean():
        job = run('launchctl', 'print', f'gui/{uid}/{label}', capture=True, check=False)
        return job.returncode != 0 and not (root/'postgres/postmaster.pid').exists()
    if not clean():
        # Independent of event history or survival of the original GUI.
        run('open', '-n', app, '--args', '--probe-cleanup')
    deadline = clock()+65
    while clock() < deadline:
        if clean(): return
        sleep(.2)
    raise RuntimeError('Owned service/database cleanup timed out; ' + '; '.join(errors))

def cleanup_certificate(run, certificate, keychain, evidence):
    errors = []
    def remove(*command):
        try:
            result = run(*command, check=False)
            if result.returncode: errors.append(f'{command[1]} exited {result.returncode}')
        except Exception as exc: errors.append(str(exc))
    # Trust removal does not depend on fingerprint extraction succeeding.
    remove('security', 'remove-trusted-cert', certificate)
    try:
        fingerprint = run('/usr/bin/openssl', 'x509', '-in', certificate, '-noout', '-fingerprint', '-sha1', capture=True).stdout.strip().split('=', 1)[1].replace(':', '').upper()
    except Exception as exc:
        raise RuntimeError('; '.join(errors + [f'Certificate fingerprint: {exc}']))
    remove('security', 'delete-certificate', '-Z', fingerprint, keychain)
    try:
        certs = run('security', 'find-certificate', '-a', '-Z', keychain, capture=True)
        if fingerprint in certs.stdout.upper(): errors.append('Owned certificate remains in keychain')
    except Exception as exc: errors.append(str(exc))
    try:
        exported = evidence/'user-trust-after.plist'
        result = run('security', 'trust-settings-export', exported, capture_errors=True, check=False)
        if result.returncode:
            # Security reports an empty user trust domain as an error, not a plist.
            if result.returncode == 1 and 'SecTrustSettingsCreateExternalRepresentation: No Trust Settings were found.' in result.stderr:
                trust = {'trustList': {}}
                exported.write_bytes(plistlib.dumps(trust))
            else:
                raise RuntimeError(f'Trust export failed: {result.stderr}')
        else:
            with exported.open('rb') as stream: trust = plistlib.load(stream)
        if fingerprint in {str(k).upper() for k in trust.get('trustList', {})}: errors.append('Owned certificate trust remains')
    except Exception as exc: errors.append(str(exc))
    if errors: raise RuntimeError('; '.join(errors))

def cleanup_phases(phases):
    errors = []
    for name, action in phases:
        try: action()
        except Exception as exc: errors.append(f'{name}: {exc}')
    return errors

def final_verdict(lifecycle, errors):
    return {**lifecycle, 'result': 'passed' if lifecycle.get('lifecycle') == 'passed' and not errors else 'failed', 'cleanupErrors': errors}
