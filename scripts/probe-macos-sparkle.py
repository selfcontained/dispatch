#!/usr/bin/env python3
"""Opt-in local Sparkle experiment. No installed app, login item, or user DB access.
Requires an existing signed dist/macos/arm64/Dispatch.app and a --jobs 1 probe
build using DISPATCH_SPARKLE_PROBE_SDK. SDK must be verified Sparkle 2.10.0.
"""
import argparse, atexit, base64, functools, hashlib, http.server, json, os, pathlib, plistlib
import shutil, signal, socket, subprocess, tempfile, threading, time, urllib.parse, urllib.request, uuid

parser = argparse.ArgumentParser()
parser.add_argument('--case', choices=['running', 'stopped', 'bad-signature'], required=True)
parser.add_argument('--sdk', type=pathlib.Path, required=True)
parser.add_argument('--identity', required=True)
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parent.parent
sdk = args.sdk.resolve()
assert hashlib.sha256((sdk/'sdk.tar.xz').read_bytes()).hexdigest() == 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c'
root = pathlib.Path(tempfile.mkdtemp(prefix='dispatch-macos-test-sparkle-', dir='/tmp'))
os.chmod(root, 0o700)
atexit.register(lambda: (root/'private-key').unlink(missing_ok=True))
print(f'Probe root: {root}', flush=True)
(root/'case.txt').write_text(args.case)
feed = root/'feed'; feed.mkdir()
installed = root/'installed'/'Dispatch Sparkle Probe.app'
updated = feed/'Dispatch Sparkle Probe.app'
identifier = 'dev.bradharris.dispatch.sparkleprobe.' + uuid.uuid4().hex
probe_log = (root/'commands.log').open('w')

def run(*command, capture=False, **kwargs):
    return subprocess.run([str(c) for c in command], check=True, stdout=subprocess.PIPE if capture else probe_log, stderr=probe_log, text=True, **kwargs).stdout

def sign(path):
    run('codesign', '--force', '--sign', args.identity, '--options', 'runtime', '--timestamp', path)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *values):
        with (root/'http.log').open('a') as log: log.write(fmt % values + '\n')

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(feed)))
threading.Thread(target=server.serve_forever, daemon=True).start()
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); api_port = sock.getsockname()[1]
assert api_port != 6767
key_script = root/'key.swift'
key_script.write_text('''import Foundation
import CryptoKit
let key = Curve25519.Signing.PrivateKey()
let root = URL(fileURLWithPath: CommandLine.arguments[1])
try key.rawRepresentation.base64EncodedString().write(to: root.appendingPathComponent("private-key"), atomically: true, encoding: .utf8)
try key.publicKey.rawRepresentation.base64EncodedString().write(to: root.appendingPathComponent("public-key"), atomically: true, encoding: .utf8)
''')
run('swift', key_script, root)
os.chmod(root/'private-key', 0o600)
public_key = (root/'public-key').read_text()
source = repo/'dist/macos/arm64/Dispatch.app'
assert source.is_dir()
run('ditto', source, installed)
contents = installed/'Contents'
shutil.copy2(repo/'apps/macos/.build/out/Products/Release/DispatchMenu', contents/'MacOS/DispatchMenu')
framework = contents/'Frameworks/Sparkle.framework'
run('ditto', sdk/'Sparkle.framework', framework)
with (contents/'Info.plist').open('rb') as f: info = plistlib.load(f)
info.update(CFBundleIdentifier=identifier, CFBundleName='Dispatch Sparkle Probe', CFBundleDisplayName='Dispatch Sparkle Probe', CFBundleVersion='1', CFBundleShortVersionString='0.0.1', SUPublicEDKey=public_key, SUFeedURL=f'http://127.0.0.1:{server.server_port}/appcast.xml', SUEnableAutomaticChecks=False, SUAutomaticallyUpdate=True, SUAllowsAutomaticUpdates=True, SUVerifyUpdateBeforeExtraction=True, DispatchSparkleProbeRoot=str(root), DispatchProbePort=api_port, DispatchProbeRunning=args.case!='stopped', NSAppTransportSecurity={'NSAllowsLocalNetworking':True, 'NSAllowsArbitraryLoads':True})
with (contents/'Info.plist').open('wb') as f: plistlib.dump(info, f)
# All nested Sparkle executables must use the same Developer ID as the host.
version = framework/'Versions/B'
for path in [version/'XPCServices/Downloader.xpc', version/'XPCServices/Installer.xpc', version/'Autoupdate', version/'Updater.app', framework]: sign(path)
sign(installed)
run('codesign', '--verify', '--deep', '--strict', installed)
run('ditto', installed, updated)
info['CFBundleVersion']='2'; info['CFBundleShortVersionString']='0.0.2'
with (updated/'Contents/Info.plist').open('wb') as f: plistlib.dump(info, f)
sign(updated)
run('codesign', '--verify', '--deep', '--strict', updated)
archive = feed/'update.zip'
run('ditto', '-c', '-k', '--keepParent', updated, archive)
signature = run(sdk/'bin/sign_update', '--ed-key-file', root/'private-key', '-p', archive, capture=True).strip()
if args.case=='bad-signature': signature=base64.b64encode(bytes(64)).decode()
(feed/'appcast.xml').write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Dispatch isolated probe</title><item><title>Probe 2</title><sparkle:version>2</sparkle:version><sparkle:shortVersionString>0.0.2</sparkle:shortVersionString><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><enclosure url="http://127.0.0.1:{server.server_port}/update.zip" sparkle:edSignature="{signature}" length="{archive.stat().st_size}" type="application/octet-stream"/></item></channel></rss>''')

def events():
    path=root/'sparkle-events.jsonl'
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

def wait_event(name, build=None, timeout=90):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        rows=events()
        matching=[e for e in rows if e['event']==name and (build is None or e['build']==build)]
        if matching: return matching[-1]
        errors=[e for e in rows if e['event']=='error']
        if errors: raise RuntimeError(str(errors))
        time.sleep(.2)
    raise TimeoutError(f'Waiting for {name} build {build}; events={events()}')

def sql(statement):
    config=json.loads((root/'configuration.json').read_text())
    url=urllib.parse.urlsplit(config['databaseURL'])
    assert url.hostname=='127.0.0.1' and url.path=='/dispatch_mac' and url.port!=6767
    env=os.environ.copy();env.update(PGPASSWORD=urllib.parse.unquote(url.password), PGHOST=url.hostname, PGPORT=str(url.port), PGUSER=url.username, PGDATABASE='dispatch_mac')
    return run(installed/'Contents/Helpers/Postgres/bin/psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement, capture=True, env=env).strip()

def set_running(start):
    request={'id':str(uuid.uuid4()), 'start':start, 'created':time.time()-978307200}
    temporary=root/'request.tmp'
    temporary.write_text(json.dumps(request));temporary.chmod(0o600)
    temporary.replace(root/'service-request.json')
    end=time.monotonic()+60
    while time.monotonic()<end:
        runtime=json.loads((root/'service-runtime.json').read_text())
        if runtime.get('requestID','').lower()==request['id'].lower() and runtime['phase']==('running' if start else 'stopped'):
            if not start: return
            try:
                opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(f'http://127.0.0.1:{api_port}/api/v1/health',timeout=1) as response:
                    if json.load(response).get('status')=='ok': return
            except OSError: pass
        time.sleep(.2)
    raise TimeoutError('Probe service command did not complete')

try:
    run('open', '-n', installed)
    wait_event('ready', '1')
    if args.case=='stopped': set_running(True)
    sql("INSERT INTO sessions(token,expires_at) VALUES ('sparkle-probe-login',now()+interval '1 day'); INSERT INTO agents(id,name,status,cwd,cli_session_id) VALUES ('sparkle-probe-agent','Sparkle preservation probe','archived','/tmp','sparkle-engine-session');")
    if args.case=='stopped': set_running(False)
    preserved={n:json.loads((root/n).read_text()) for n in ['configuration.json','local-database.json','startup.json']}
    (root/'begin-update').touch()
    if args.case=='bad-signature':
        rejection=wait_event('update-aborted','1')
        assert not any(e['event']=='stopping-supervisor' for e in events())
        with (installed/'Contents/Info.plist').open('rb') as f: assert plistlib.load(f)['CFBundleVersion']=='1'
        assert sql("SELECT cli_session_id FROM agents WHERE id='sparkle-probe-agent'")=='sparkle-engine-session'
        result={'case':args.case,'result':'passed','rejection':rejection['details']}
    else:
        wait_event('ready','2',timeout=120)
        assert any(e['event']=='supervisor-stopped' and e['build']=='1' and e['details']=='database-stopped' for e in events())
        with (installed/'Contents/Info.plist').open('rb') as f: assert plistlib.load(f)['CFBundleVersion']=='2'
        if args.case=='running':
            assert sql("SELECT cli_session_id FROM agents WHERE id='sparkle-probe-agent'")=='sparkle-engine-session'
            assert sql("SELECT count(*) FROM sessions WHERE token='sparkle-probe-login'")=='1'
        else:
            assert not (root/'postgres/postmaster.pid').exists()
            set_running(True)
            assert sql("SELECT cli_session_id FROM agents WHERE id='sparkle-probe-agent'")=="sparkle-engine-session"
            assert sql("SELECT count(*) FROM sessions WHERE token='sparkle-probe-login'")=="1"
            set_running(False)
        run('codesign','--verify','--deep','--strict',installed)
        result={'case':args.case,'result':'passed','newBuild':'2'}
    assert all(json.loads((root/n).read_text())==v for n,v in preserved.items()),'Saved state changed'
    result['settingsAndCredentialsUnchanged']=True
    (root/'result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
finally:
    # Signal only exact probe app PIDs recorded by this isolated harness. Its
    # native termination delegate stops/reaps its own supervisor and database.
    for pid in {e['pid'] for e in events()}:
        current=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout.strip()
        if current and pathlib.Path(current).resolve()==(installed/'Contents/MacOS/DispatchMenu').resolve():
            os.kill(pid,signal.SIGTERM)
    cleaned=False
    end=time.monotonic()+60
    while time.monotonic()<end:
        if not (root/'postgres/postmaster.pid').exists() and not any(subprocess.run(['ps','-p',str(e['details']),'-o','command='],capture_output=True,text=True).stdout.strip().startswith(str(installed/'Contents/MacOS/DispatchMenu')) for e in events() if e['event']=='supervisor-started'):
            cleaned=True
            break
        time.sleep(.2)
    server.shutdown();server.server_close()
    (root/'private-key').unlink(missing_ok=True)
    probe_log.close()
    print(f'Evidence retained: {root}',flush=True)
    if not cleaned:
        (root/'result.json').write_text(json.dumps({'case':args.case,'result':'failed','reason':'Owned service did not finish cleanup'}))
        raise RuntimeError('Owned probe service did not finish cleanup; inspect its recorded PID before further tests')
