#!/usr/bin/env python3
"""Build two notarized, test-only Sparkle/SMAppService bundles on a CI Mac.
No service registration, installation, or release publication is performed.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile

SDK_SHA256 = 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c'
parser = argparse.ArgumentParser()
parser.add_argument('--base-app', type=Path, required=True)
parser.add_argument('--sdk', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--proof-id', required=True)
parser.add_argument('--identity', required=True)
parser.add_argument('--notary-profile', required=True)
parser.add_argument('--notary-keychain', required=True)
args = parser.parse_args()
assert re.fullmatch(r'[a-z0-9-]{1,40}', args.proof_id)
assert hashlib.sha256((args.sdk/'sdk.tar.xz').read_bytes()).hexdigest() == SDK_SHA256
assert not args.output.exists(), 'Use a fresh artifact output directory'
repo = Path(__file__).resolve().parent.parent
args.output.mkdir(parents=True)
identity = f'dev.bradharris.dispatch.sparkleprobe.service{args.proof_id}'
label = identity + '.server'
state_root = f'/tmp/dispatch-macos-test-sparkle-service-{args.proof_id}'
app_name = f'Dispatch Sparkle Proof {args.proof_id}.app'
feed_url = 'https://localhost:58443/appcast.xml'

def run(*command, capture=False, **kwargs):
    return subprocess.run([str(c) for c in command], check=True, text=True, stdout=subprocess.PIPE if capture else None, **kwargs).stdout

def sign(path):
    run('codesign', '--force', '--sign', args.identity, '--options', 'runtime', '--timestamp', path)

def notarize(app, archive):
    run('ditto', '-c', '-k', '--keepParent', app, archive)
    run('xcrun', 'notarytool', 'submit', archive, '--keychain-profile', args.notary_profile, '--keychain', args.notary_keychain, '--wait')
    run('xcrun', 'stapler', 'staple', app)
    run('xcrun', 'stapler', 'validate', app)
    run('codesign', '--verify', '--deep', '--strict', app)
    run('spctl', '--assess', '--type', 'execute', '--verbose', app)
    archive.unlink()
    run('ditto', '-c', '-k', '--keepParent', app, archive)

with tempfile.TemporaryDirectory(prefix='dispatch-sparkle-proof-build-') as scratch:
    temporary = Path(scratch)
    os.chmod(temporary, 0o700)
    key_script = temporary/'key.swift'
    key_script.write_text('''import Foundation
import CryptoKit
let key = Curve25519.Signing.PrivateKey()
let root = URL(fileURLWithPath: CommandLine.arguments[1])
try key.rawRepresentation.base64EncodedString().write(to: root.appendingPathComponent("private-key"), atomically: true, encoding: .utf8)
try key.publicKey.rawRepresentation.base64EncodedString().write(to: root.appendingPathComponent("public-key"), atomically: true, encoding: .utf8)
''')
    run('swift', key_script, temporary)
    (temporary/'private-key').chmod(0o600)
    public_key = (temporary/'public-key').read_text()
    # Use a separate build directory: cannot contaminate the ordinary app build.
    build = temporary/'swift-build'
    env = os.environ.copy()
    env['DISPATCH_SPARKLE_PROBE_SDK'] = str(args.sdk.resolve())
    swift = ['swift', 'build', '--package-path', repo/'apps/macos', '--scratch-path', build, '--configuration', 'release', '--triple', 'arm64-apple-macosx13.0', '--jobs', '1']
    run(*swift, env=env)
    binary_dir = Path(run(*swift, '--show-bin-path', env=env, capture=True).strip())
    app = temporary/app_name
    run('lipo', args.base_app/'Contents/Helpers/dispatch', '-verify_arch', 'arm64')
    run('ditto', args.base_app, app)
    contents = app/'Contents'
    shutil.copy2(binary_dir/'DispatchMenu', contents/'MacOS/DispatchMenu')
    framework = contents/'Frameworks/Sparkle.framework'
    run('ditto', args.sdk/'Sparkle.framework', framework)
    # Remove the actual product's service plist; this fixture owns only its label.
    agent_directory = contents/'Library/LaunchAgents'
    for existing in agent_directory.glob('*.plist'): existing.unlink()
    with (agent_directory/(label+'.plist')).open('wb') as f:
        plistlib.dump({'Label':label,'BundleProgram':'Contents/MacOS/DispatchMenu','ProgramArguments':['DispatchMenu','--server','--isolated-test',state_root], 'RunAtLoad':True,'KeepAlive':{'SuccessfulExit':False},'ExitTimeOut':60,'ThrottleInterval':30,'AbandonProcessGroup':True,'AssociatedBundleIdentifiers':[identity]},f)
    with (contents/'Info.plist').open('rb') as f: info = plistlib.load(f)
    info.update(CFBundleIdentifier=identity, CFBundleName=app_name[:-4], CFBundleDisplayName=app_name[:-4], CFBundleVersion='1', CFBundleShortVersionString='0.0.1', SUPublicEDKey=public_key, SUFeedURL=feed_url, SUEnableAutomaticChecks=False, SUAutomaticallyUpdate=True, SUAllowsAutomaticUpdates=True, SUVerifyUpdateBeforeExtraction=True, DispatchSparkleProbeRoot=state_root, DispatchProbePort=56789, DispatchProbeRunning=True, DispatchProbeServiceLabel=label)
    # HTTPS only; the disposable Mac trusts its own local feed certificate.
    info.pop('NSAppTransportSecurity', None)
    with (contents/'Info.plist').open('wb') as f: plistlib.dump(info,f)
    version = framework/'Versions/B'
    for code in [version/'XPCServices/Downloader.xpc', version/'XPCServices/Installer.xpc', version/'Autoupdate', version/'Updater.app', framework]: sign(code)
    sign(app)
    notarize(app, args.output/'initial.zip')
    info['CFBundleVersion']='2';info['CFBundleShortVersionString']='0.0.2'
    with (contents/'Info.plist').open('wb') as f: plistlib.dump(info,f)
    sign(app)
    notarize(app, args.output/'update.zip')
    signature = run(args.sdk/'bin/sign_update', '--ed-key-file', temporary/'private-key', '-p', args.output/'update.zip', capture=True).strip()
    assert len(base64.b64decode(signature, validate=True)) == 64
    (args.output/'appcast.xml').write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Dispatch notarized service proof</title><item><title>Service proof build 2</title><sparkle:version>2</sparkle:version><sparkle:shortVersionString>0.0.2</sparkle:shortVersionString><sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion><enclosure url="https://localhost:58443/update.zip" sparkle:edSignature="{signature}" length="{(args.output/'update.zip').stat().st_size}" type="application/octet-stream"/></item></channel></rss>''')
    metadata = {'bundleID':identity,'serviceLabel':label,'stateRoot':state_root,'appName':app_name,'feedURL':feed_url,'apiPort':56789,'builds':['1','2'],'sparkleVersion':'2.10.0','sdkSHA256':SDK_SHA256,'archiveSHA256':{name:hashlib.sha256((args.output/name).read_bytes()).hexdigest() for name in ['initial.zip','update.zip']}}
    (args.output/'proof.json').write_text(json.dumps(metadata,indent=2))
    shutil.copy2(repo/'scripts/validate-macos-sparkle-proof.py',args.output/'validate.py')
    shutil.copy2(repo/'scripts/sparkle_proof_cleanup.py',args.output/'sparkle_proof_cleanup.py')
    shutil.copy2(repo/'scripts/sparkle_proof_live.py',args.output/'sparkle_proof_live.py')
    shutil.copy2(repo/'scripts/fixtures/sparkle-acp.py',args.output/'fake-acp.py')
print(f'Notarized service proof artifacts ready: {args.output}')
