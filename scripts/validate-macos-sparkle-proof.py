#!/usr/bin/env python3
"""Run ONLY on an explicitly approved disposable Mac with a logged-in GUI user.
Installs a unique test app/background item and a temporary user-trusted TLS cert.
Never installs or replaces the normal Dispatch application.
"""
import argparse
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--artifacts', type=Path, default=Path(__file__).resolve().parent)
parser.add_argument('--case', choices=['running','stopped'], required=True)
parser.add_argument('--allow-machine-changes', action='store_true', help='Required: user has approved this disposable Mac')
args = parser.parse_args()
if not args.allow_machine_changes: parser.error('This test changes app installation, user certificate trust, and background service registration. Obtain approval first.')
assert sys.platform == 'darwin' and os.getuid() != 0, 'Run as the disposable Mac GUI user'
artifacts = args.artifacts.resolve()
meta = json.loads((artifacts/'proof.json').read_text())
identity = meta['bundleID'];label = meta['serviceLabel'];root = Path(meta['stateRoot'])
assert re.fullmatch(r'dev\.bradharris\.dispatch\.sparkleprobe\.service[a-z0-9-]{1,40}', identity)
assert label == identity+'.server'
assert root.parent == Path('/tmp') and root.name.startswith('dispatch-macos-test-sparkle-service-')
assert re.fullmatch(r'Dispatch Sparkle Proof [a-z0-9-]{1,40}\.app', meta['appName'])
assert meta['feedURL']=='https://localhost:58443/appcast.xml' and meta['apiPort']==56789
app = Path('/Applications')/meta['appName']
assert not app.exists() and not root.exists(), 'Existing proof installation/data found; inspect and clean up before retrying'
for name in ['initial.zip','update.zip']:
    assert hashlib.sha256((artifacts/name).read_bytes()).hexdigest()==meta['archiveSHA256'][name]
# Fail before modifying anything if either dedicated test port is occupied.
for port in [58443,56789]:
    with socket.socket() as sock: sock.bind(('127.0.0.1',port))
assert subprocess.run(['launchctl','print',f'gui/{os.getuid()}/{label}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode != 0, 'A prior test service still exists'
root.mkdir(mode=0o700)
evidence = artifacts/'evidence'/f'{args.case}-{uuid.uuid4().hex}'
evidence.mkdir(parents=True, mode=0o700)
log = (evidence/'commands.log').open('w')
server = None; trusted = False; registered_app = False; completed = False

def run(*command, capture=False, check=True, **kwargs):
    return subprocess.run([str(c) for c in command], check=check, text=True, stdout=subprocess.PIPE if capture else log, stderr=log, **kwargs)

def events():
    path=root/'sparkle-events.jsonl'
    return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

def wait_event(name, build, timeout=600):
    deadline=time.monotonic()+timeout; told_approval=False
    while time.monotonic()<deadline:
        rows=events()
        if not told_approval and any(e['event']=='approval-required' for e in rows):
            print('Approve ONLY the Dispatch Sparkle Proof background item in the disposable Mac System Settings.',flush=True);told_approval=True
        errors=[e for e in rows if e['event'] in ['error','update-aborted']]
        if errors: raise RuntimeError(str(errors))
        if any(e['event']==name and e['build']==build for e in rows): return
        time.sleep(.25)
    raise TimeoutError(f'Waiting for {name} build {build}')

def service_record():
    result=run('launchctl','print',f'gui/{os.getuid()}/{label}',capture=True,check=False)
    if result.returncode: return None
    pid=re.search(r'^\s*pid = (\d+)$',result.stdout,re.M)
    assert pid, 'Registered service has no PID'
    pid=int(pid.group(1))
    paths=run('/usr/sbin/lsof','-a','-p',str(pid),'-d','txt','-Fn',capture=True).stdout
    assert str(app/'Contents/MacOS/DispatchMenu') in paths, 'Service executable is not the installed proof app'
    return {'label':label,'pid':pid,'executable':str(app/'Contents/MacOS/DispatchMenu')}

def service_state(start):
    request={'id':str(uuid.uuid4()),'start':start,'created':time.time()-978307200}
    temporary=root/'request.tmp';temporary.write_text(json.dumps(request));temporary.chmod(0o600);temporary.replace(root/'service-request.json')
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        runtime=json.loads((root/'service-runtime.json').read_text())
        if runtime.get('requestID','').lower()==request['id'] and runtime['phase']==('running' if start else 'stopped'):
            if not start: return
            try:
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:56789/api/v1/health',timeout=1) as response:
                    body=json.load(response)
                    config=json.loads((root/'configuration.json').read_text())
                    if body.get('status')=='ok' and body.get('macInstanceId')==config['instanceID']: return
            except OSError: pass
        time.sleep(.2)
    raise TimeoutError('Service state did not converge')

def sql(statement):
    config=json.loads((root/'configuration.json').read_text());url=urllib.parse.urlsplit(config['databaseURL'])
    assert url.hostname=='127.0.0.1' and url.path=='/dispatch_preview' and url.port not in [6767,5432]
    env=os.environ.copy();env.update(PGHOST=url.hostname,PGPORT=str(url.port),PGUSER=url.username,PGPASSWORD=urllib.parse.unquote(url.password),PGDATABASE='dispatch_preview',PGCONNECT_TIMEOUT='3')
    return run(app/'Contents/Helpers/Postgres/bin/psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',statement,capture=True,env=env).stdout.strip()

try:
    certificate=root/'feed-cert.pem';key=root/'feed-key.pem';config=root/'tls.cnf'
    config.write_text(f'[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Dispatch Sparkle Proof {identity}\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign,cRLSign\nextendedKeyUsage=serverAuth\n')
    run('/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-config',config,'-keyout',key,'-out',certificate)
    key.chmod(0o600)
    keychain=Path.home()/'Library/Keychains/login.keychain-db'
    run('security','add-trusted-cert','-r','trustRoot','-k',keychain,certificate);trusted=True
    handler=functools.partial(http.server.SimpleHTTPRequestHandler,directory=str(artifacts))
    server=http.server.ThreadingHTTPServer(('127.0.0.1',58443),handler)
    tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(certificate,key)
    server.socket=tls.wrap_socket(server.socket,server_side=True)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    staging=root/'unpack';staging.mkdir()
    run('ditto','-x','-k',artifacts/'initial.zip',staging)
    assert sorted(p.name for p in staging.iterdir())==[meta['appName']]
    run('ditto',staging/meta['appName'],app);registered_app=True
    with (app/'Contents/Info.plist').open('rb') as f: info=plistlib.load(f)
    assert info['CFBundleIdentifier']==identity and info['DispatchProbeServiceLabel']==label and info['DispatchSparkleProbeRoot']==str(root)
    run('codesign','--verify','--deep','--strict',app)
    run('xcrun','stapler','validate',app)
    run('spctl','--assess','--type','execute','--verbose',app)
    (root/'service-proof-approved').write_text(identity)
    run('open','-n',app)
    wait_event('ready','1')
    before=service_record();assert before
    sql("INSERT INTO sessions(token,expires_at) VALUES ('sparkle-service-login',now()+interval '1 day'); INSERT INTO agents(id,name,status,cwd,cli_session_id) VALUES ('sparkle-service-agent','Service proof','archived','/tmp','service-proof-engine-session');")
    if args.case=='stopped': service_state(False)
    saved={name:json.loads((root/name).read_text()) for name in ['configuration.json','local-database.json','startup.json']}
    (root/'begin-update').touch()
    wait_event('upgrade-confirmed','2')
    after=service_record();assert after and after['pid']!=before['pid']
    # Any surviving old PID is a failure, even if the new service is healthy.
    assert run('ps','-p',str(before['pid']),capture=True,check=False).returncode!=0
    rows=events()
    assert any(e['build']=='1' and e['event']=='service-unregistered' for e in rows)
    assert not any(e['build']=='2' and e['event']=='approval-required' for e in rows), 'Update required renewed background approval'
    with (app/'Contents/Info.plist').open('rb') as f: assert plistlib.load(f)['CFBundleVersion']=='2'
    run('codesign','--verify','--deep','--strict',app)
    run('xcrun','stapler','validate',app)
    run('spctl','--assess','--type','execute','--verbose',app)
    if args.case=='stopped':
        assert json.loads((root/'service-runtime.json').read_text())['phase']=='stopped'
        assert not (root/'postgres/postmaster.pid').exists()
        service_state(True)
    assert sql("SELECT cli_session_id FROM agents WHERE id='sparkle-service-agent'")=='service-proof-engine-session'
    assert sql("SELECT count(*) FROM sessions WHERE token='sparkle-service-login'")=='1'
    assert all(json.loads((root/name).read_text())==value for name,value in saved.items())
    if args.case=='stopped':service_state(False)
    (evidence/'result.json').write_text(json.dumps({'result':'passed','case':args.case,'before':before,'after':after,'notarization':'staples and Gatekeeper verified for both versions','statePreserved':True,'repeatApprovalRequired':False},indent=2))
    completed=True
finally:
    # Native cleanup unregisters only this bundle's unique SMAppService label.
    rows=events()
    for pid in {e['pid'] for e in rows}:
        current=run('ps','-p',str(pid),'-o','command=',capture=True,check=False).stdout.strip()
        if current and Path(current).resolve()==(app/'Contents/MacOS/DispatchMenu').resolve():os.kill(pid,signal.SIGTERM)
    deadline=time.monotonic()+60;clean=False
    while time.monotonic()<deadline:
        job=run('launchctl','print',f'gui/{os.getuid()}/{label}',capture=True,check=False)
        if job.returncode and not (root/'postgres/postmaster.pid').exists():clean=True;break
        time.sleep(.2)
    if server:server.shutdown();server.server_close()
    if trusted:
        run('security','remove-trusted-cert',root/'feed-cert.pem',check=False)
        fingerprint=run('/usr/bin/openssl','x509','-in',root/'feed-cert.pem','-noout','-fingerprint','-sha1',capture=True).stdout.strip().split('=',1)[1].replace(':','')
        run('security','delete-certificate','-Z',fingerprint,Path.home()/'Library/Keychains/login.keychain-db',check=False)
    if (root/'sparkle-events.jsonl').exists():shutil.copy2(root/'sparkle-events.jsonl',evidence/'sparkle-events.jsonl')
    if clean:
        if registered_app:shutil.rmtree(app)
        if completed:shutil.rmtree(root)
    else:
        (evidence/'cleanup-failed.txt').write_text('Test service or database remains. Keep app/data for explicit cleanup; do not retry over it.')
    log.close()
    print(f'Evidence: {evidence}',flush=True)
    if not clean:raise RuntimeError('Owned test service cleanup did not finish')
