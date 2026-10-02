#!/usr/bin/env python3
import base64
import functools
import http.server
import os
import plistlib
import re
import shutil
import subprocess
import threading
import unittest
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
import xml.etree.ElementTree as ET

import macos_appcast as appcast
from macos_appcast import DISPATCH_NS, NS, RECOVERY, add, archive_name, build_version, new_item, parse, promote, render

SIGNATURE = base64.b64encode(bytes(64)).decode()


def node_public_key(seed):
    """Derive the raw Ed25519 public key with Node, independently of the helper."""
    script = ("const c=require('crypto');let d='';process.stdin.on('data',x=>d+=x).on('end',()=>{"
              "const k=c.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),"
              "Buffer.from(d,'base64')]),format:'der',type:'pkcs8'});"
              "process.stdout.write(c.createPublicKey(k).export({format:'der',type:'spki'}).subarray(-32).toString('base64'))})")
    return subprocess.run(['node', '-e', script], input=seed.encode(), capture_output=True, check=True).stdout.decode()


def synthetic_keys():
    seed = base64.b64encode(os.urandom(32)).decode()
    return {'MACOS_SPARKLE_PRIVATE_KEY': seed, 'DISPATCH_SPARKLE_PUBLIC_KEY': node_public_key(seed)}


KEYS = synthetic_keys()
OTHER_KEYS = synthetic_keys()


def sparkle_extract(data):
    """Python port of Sparkle 2.10 SPUExtractAppcastContent."""
    prefix = data.rfind(b'<!-- sparkle-signatures:\n')
    if prefix < 0:
        return data, None, 0
    suffix = data.find(b'-->', prefix + 25)
    if suffix < 0:
        return data, None, 0
    signature, length = None, 0
    for line in data[prefix + 25:suffix].decode().splitlines():
        if line.startswith('edSignature:'):
            signature = line[len('edSignature:'):].strip()
        elif line.startswith('length:'):
            length = int(line[len('length:'):].strip())
    return data[:prefix], signature, length


def independent_verify(content, signature, public_key):
    script = ("const c=require('crypto');const [s,p]=process.argv.slice(1);let d=[];"
              "process.stdin.on('data',x=>d.push(x)).on('end',()=>{const k=c.createPublicKey({key:Buffer.concat("
              "[Buffer.from('302a300506032b6570032100','hex'),Buffer.from(p,'base64')]),format:'der',type:'spki'});"
              "process.exit(c.verify(null,Buffer.concat(d),k,Buffer.from(s,'base64'))?0:1)})")
    return subprocess.run(['node', '-e', script, signature, public_key], input=content).returncode == 0


def item(build, version='1.0.0'):
    return new_item(build, version, SIGNATURE, 7)


class MetadataTests(unittest.TestCase):
    def test_numeric_build_order(self):
        self.assertGreater(build_version('100.1'), build_version('99.99'))
        self.assertGreater(build_version('100.10'), build_version('100.9'))
        for bad in ['1', '1.0', '01.1', '1.1.1', '-1.1', '1.a', '1.1\n']:
            with self.assertRaises(ValueError): build_version(bad)

    def test_rejects_bad_metadata(self):
        for signature, size in [('garbage', 1), (SIGNATURE, 0), (base64.b64encode(bytes(32)).decode(), 1)]:
            with self.assertRaises(ValueError): new_item('123.1', '1.0.0', signature, size)
        for version in ['0.38.14', '1.0', '<inject>', 'v1.0.0']:
            with self.assertRaises(ValueError): new_item('123.1', version, SIGNATURE, 1)

    def test_render_round_trips_and_points_at_the_release(self):
        data = render([item('123.2', '1.2.3')])
        element = ET.fromstring(data).find('./channel/item')
        self.assertEqual(element.findtext(f'{{{NS}}}channel'), 'preview')
        self.assertEqual(element.findtext(f'{{{NS}}}minimumSystemVersion'), '13.0')
        self.assertEqual(element.find('enclosure').get('url'), 'https://github.com/selfcontained/dispatch/releases/download/v1.2.3/dispatch-macos-123.2-arm64.zip')
        self.assertEqual(parse(data), [item('123.2', '1.2.3')])
        self.assertEqual(archive_name('123.2'), 'dispatch-macos-123.2-arm64.zip')

    def test_parse_rejects_foreign_archives_and_channels(self):
        data = render([item('123.2')]).replace(b'releases/download/v1.0.0', b'releases/download/v9.9.9')
        with self.assertRaisesRegex(ValueError, 'archive URL'): parse(data)
        data = render([item('123.2')]).replace(b'>preview<', b'>nightly<')
        with self.assertRaisesRegex(ValueError, 'channel'): parse(data)
        for data in [b'<rss/>', b'broken']:
            with self.assertRaises((ValueError, ET.ParseError)): parse(data)


def signed_parse(data):
    return parse(appcast.sign(data))


class RecoveryCapabilityTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(os.environ, KEYS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_capability_round_trips_under_the_dispatch_prefix(self):
        data = render([new_item('123.2', '1.2.3', SIGNATURE, 7, 1)])
        with self.assertRaisesRegex(ValueError, 'Unsigned appcast'): parse(data)
        data = appcast.sign(data)
        self.assertIn(b'xmlns:dispatch="https://dispatch.berad.dev/xml-namespaces/update"', data)
        self.assertIn(b'<dispatch:recoveryProtocol>1</dispatch:recoveryProtocol>', data)
        self.assertEqual(parse(data)[0]['recoveryProtocol'], 1)

    def test_absent_capability_is_preserved_never_invented(self):
        legacy = render([item('100.1', '1.0.0')])
        self.assertNotIn(b'recoveryProtocol', legacy)
        items = add(parse(legacy), new_item('101.1', '1.0.1', SIGNATURE, 7, 1))
        items = promote(signed_parse(render(items)), '1.0.0')
        self.assertEqual({i['build']: i['recoveryProtocol'] for i in signed_parse(render(items))}, {'100.1': None, '101.1': 1})

    def test_unsigned_migration_never_carries_a_capability(self):
        # Legitimate pre-signing baseline: reused, and no claim is synthesized.
        baseline = parse(render([item('100.1', '1.0.0')]))
        self.assertEqual([i['recoveryProtocol'] for i in baseline], [None])
        self.assertNotIn(b'recoveryProtocol', sparkle_extract(appcast.sign(render(baseline)))[0])
        # A signed capability feed with its signature stripped.
        signed = appcast.sign(render([new_item('101.1', '1.0.1', SIGNATURE, 7, 1), item('100.1', '1.0.0')]))
        with self.assertRaisesRegex(ValueError, 'Unsigned appcast declares'): parse(sparkle_extract(signed)[0])
        # An arbitrary unsigned feed claiming protocol 1, even on an old entry.
        with self.assertRaisesRegex(ValueError, 'Unsigned appcast declares'):
            parse(render([new_item('100.1', '1.0.0', SIGNATURE, 7, 1)]))
        with patch.object(appcast, 'fetch_public', return_value=sparkle_extract(signed)[0]), patch.object(appcast, 'deploy') as deploy:
            with self.assertRaisesRegex(ValueError, 'Unsigned appcast declares'): appcast.current_items()
        deploy.assert_not_called()

    def test_strict_switch_refuses_any_unsigned_live_feed(self):
        legacy = render([item('100.1', '1.0.0')])
        with patch.object(appcast, 'REQUIRE_SIGNED_LIVE_FEED', True):
            with self.assertRaisesRegex(ValueError, 'Live appcast is unsigned'): parse(legacy)
            self.assertEqual(parse(appcast.sign(legacy)), [item('100.1', '1.0.0')])
            # A confirmed 404 still starts an empty feed.
            with patch.object(appcast, 'fetch_public', return_value=None):
                self.assertEqual(appcast.current_items(), [])

    def test_rejects_unknown_or_malformed_capabilities(self):
        for value in [0, 2, True, '1', 1.0, -1]:
            with self.assertRaises(ValueError): new_item('123.1', '1.0.0', SIGNATURE, 1, value)
        good = render([new_item('123.2', '1.2.3', SIGNATURE, 7, 1)])
        for bad in [b'>2<', b'>01<', b'> 1<', b'><', b'>x<']:
            with self.assertRaises(ValueError): signed_parse(good.replace(b'>1</dispatch', bad + b'/dispatch'))
        duplicate = good.replace(b'</dispatch:recoveryProtocol>', b'</dispatch:recoveryProtocol><dispatch:recoveryProtocol>1</dispatch:recoveryProtocol>')
        unknown = good.replace(b'</dispatch:recoveryProtocol>', b'</dispatch:recoveryProtocol><dispatch:other>1</dispatch:other>')
        for bad in [duplicate, unknown]:
            with self.assertRaisesRegex(ValueError, 'Unexpected Dispatch'): signed_parse(bad)

    def test_item_comes_from_the_app_inside_the_archive(self):
        base = {'CFBundleVersion': '123.2', 'CFBundleShortVersionString': '1.2.3', 'DispatchRecoveryProtocol': 1}
        cases = [
            (base, 1),
            ({**base, 'CFBundleVersion': '123.1'}, 'does not match'),
            ({**base, 'CFBundleShortVersionString': '1.2.4'}, 'does not match'),
            ({k: v for k, v in base.items() if k != 'DispatchRecoveryProtocol'}, 'no DispatchRecoveryProtocol'),
            ({**base, 'DispatchRecoveryProtocol': 2}, 'Unknown recovery'),
            ({**base, 'DispatchRecoveryProtocol': '1'}, 'Unknown recovery'),
            ({**base, 'DispatchRecoveryProtocol': True}, 'Unknown recovery'),
        ]
        for info, expected in cases:
            with tempfile.TemporaryDirectory(prefix='dispatch-appcast-', dir='/tmp') as directory:
                archive = write_archive(Path(directory), info)
                if expected == 1:
                    described = appcast.app_item(archive, '123.2', '1.2.3', SIGNATURE)
                    self.assertEqual((described['recoveryProtocol'], described['length']), (1, archive.stat().st_size))
                else:
                    with self.assertRaisesRegex(ValueError, expected):
                        appcast.app_item(archive, '123.2', '1.2.3', SIGNATURE)
        with tempfile.TemporaryDirectory(prefix='dispatch-appcast-', dir='/tmp') as directory:
            archive = Path(directory) / 'empty.zip'
            zipfile.ZipFile(archive, 'w').close()
            with self.assertRaises(KeyError): appcast.app_item(archive, '123.2', '1.2.3', SIGNATURE)

    def test_newer_builds_must_keep_declaring_the_protocol(self):
        capable = add([item('100.1', '1.0.0')], new_item('101.1', '1.0.1', SIGNATURE, 7, 1))
        with self.assertRaisesRegex(ValueError, 'declares no protocol'): add(capable, item('102.1', '1.0.2'))
        lapsed = render(capable + [item('102.1', '1.0.2')])
        with self.assertRaisesRegex(ValueError, 'declares no protocol'): signed_parse(lapsed)
        with self.assertRaisesRegex(ValueError, 'declares no protocol'):
            appcast.deploy(capable + [item('102.1', '1.0.2')])


BASE_INFO = {'CFBundleVersion': '123.2', 'CFBundleShortVersionString': '1.2.3', 'DispatchRecoveryProtocol': 1}


def write_archive(directory, info, name='dispatch-macos-123.2-arm64.zip'):
    """A zip shaped like `ditto -c -k --keepParent Dispatch.app`."""
    archive = directory / name
    with zipfile.ZipFile(archive, 'w') as bundle:
        bundle.writestr('Dispatch.app/Contents/Info.plist', plistlib.dumps(info))
        bundle.writestr('Dispatch.app/Contents/MacOS/Dispatch', os.urandom(64))
    return archive


def node_sign_file(path, seed):
    script = ("const c=require('crypto');const fs=require('fs');const k=c.createPrivateKey({key:Buffer.concat("
              "[Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(process.env.SEED,'base64')]),"
              "format:'der',type:'pkcs8'});process.stdout.write(c.sign(null,fs.readFileSync(process.argv[1]),k).toString('base64'))")
    return subprocess.run(['node', '-e', script, str(path)], env={**os.environ, 'SEED': seed}, capture_output=True, check=True).stdout.decode()


class PromotionArchiveTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(os.environ, KEYS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_promoted_entry_must_match_its_archive(self):
        with tempfile.TemporaryDirectory(prefix='dispatch-appcast-', dir='/tmp') as directory:
            archive = write_archive(Path(directory), BASE_INFO)
            signature = node_sign_file(archive, KEYS['MACOS_SPARKLE_PRIVATE_KEY'])
            entry = appcast.app_item(archive, '123.2', '1.2.3', signature)
            appcast.verify_archive(entry, archive)
            for changed, message in [
                ({**entry, 'length': entry['length'] + 1}, 'length'),
                ({**entry, 'signature': node_sign_file(archive, OTHER_KEYS['MACOS_SPARKLE_PRIVATE_KEY'])}, 'verify-archive failed'),
                ({**entry, 'recoveryProtocol': None}, 'Recovery protocol does not match'),
            ]:
                with self.assertRaisesRegex(ValueError, message): appcast.verify_archive(changed, archive)
            # Declared 1 but the archived app has no key: refused.
            legacy_info = {k: v for k, v in BASE_INFO.items() if k != 'DispatchRecoveryProtocol'}
            archive.unlink()
            archive = write_archive(Path(directory), legacy_info)
            missing = {**entry, 'length': archive.stat().st_size, 'signature': node_sign_file(archive, KEYS['MACOS_SPARKLE_PRIVATE_KEY'])}
            with self.assertRaisesRegex(ValueError, 'Recovery protocol does not match'): appcast.verify_archive(missing, archive)
            archive.unlink()
            archive = write_archive(Path(directory), BASE_INFO)
            # Same length, different bytes: the archive signature catches it.
            data = bytearray(archive.read_bytes()); data[-1] ^= 1; archive.write_bytes(bytes(data))
            with self.assertRaisesRegex(ValueError, 'verify-archive failed'): appcast.verify_archive(entry, archive)


    def test_authentic_legacy_entry_still_promotes(self):
        legacy_info = {k: v for k, v in BASE_INFO.items() if k != 'DispatchRecoveryProtocol'}
        with tempfile.TemporaryDirectory(prefix='dispatch-appcast-', dir='/tmp') as directory:
            archive = write_archive(Path(directory), legacy_info)
            entry = new_item('123.2', '1.2.3', node_sign_file(archive, KEYS['MACOS_SPARKLE_PRIVATE_KEY']), archive.stat().st_size)
            appcast.verify_archive(entry, archive)
            # New publication still requires the declaration.
            with self.assertRaisesRegex(ValueError, 'no DispatchRecoveryProtocol'):
                appcast.app_item(archive, '123.2', '1.2.3', entry['signature'])
            # Promotion keeps the entry legacy: no capability is synthesized.
            items = promote(parse(render([entry])), '1.2.3')
            self.assertEqual([i['recoveryProtocol'] for i in items], [None])
            for bad in [{**entry, 'version': '1.2.4'}, {**entry, 'build': '123.3'}]:
                with self.assertRaises(ValueError): appcast.verify_archive(bad, archive)
        with tempfile.TemporaryDirectory(prefix='dispatch-appcast-', dir='/tmp') as directory:
            # A legacy entry whose archive actually declares protocol 1 is refused too.
            archive = write_archive(Path(directory), BASE_INFO)
            entry = new_item('123.2', '1.2.3', node_sign_file(archive, KEYS['MACOS_SPARKLE_PRIVATE_KEY']), archive.stat().st_size)
            with self.assertRaisesRegex(ValueError, 'Recovery protocol does not match'): appcast.verify_archive(entry, archive)


class FeedSignatureTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict(os.environ, KEYS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def signed(self):
        return appcast.sign(render([new_item('123.2', '1.2.3', SIGNATURE, 7, 1), item('100.1', '1.0.0')]))

    def test_signed_bytes_match_sparkle_format_and_verify(self):
        content = render([new_item('123.2', '1.2.3', SIGNATURE, 7, 1)])
        signed = appcast.sign(content)
        extracted, signature, length = sparkle_extract(signed)
        self.assertEqual(extracted, content)
        self.assertEqual(length, len(content))
        self.assertRegex(signature, r'^[A-Za-z0-9+/]{86}==$')
        self.assertEqual(signed, content + f'<!-- sparkle-signatures:\nedSignature: {signature}\nlength: {len(content)}\n-->\n'.encode())
        self.assertTrue(independent_verify(extracted, signature, KEYS['DISPATCH_SPARKLE_PUBLIC_KEY']))
        self.assertFalse(independent_verify(extracted, signature, OTHER_KEYS['DISPATCH_SPARKLE_PUBLIC_KEY']))
        # Older apps parse the signed feed as ordinary XML.
        self.assertEqual(len(ET.fromstring(signed).findall('./channel/item')), 1)
        self.assertEqual(parse(signed)[0]['recoveryProtocol'], 1)

    def test_tampered_or_foreign_feeds_are_rejected(self):
        signed = self.signed()
        content, signature, length = sparkle_extract(signed)
        block = signed[len(content):]
        tampered = [
            signed.replace(b'<dispatch:recoveryProtocol>1<', b'<dispatch:recoveryProtocol>2<'),
            signed.replace(b'1.2.3', b'1.2.4'),
            signed.replace(b'<sparkle:channel>preview</sparkle:channel>', b'', 1),
            content.replace(b'<dispatch:recoveryProtocol>1</dispatch:recoveryProtocol>', b'') + block,
            content + block.replace(f'length: {length}'.encode(), f'length: {length + 1}'.encode()),
            content + block.replace(signature.encode(), base64.b64encode(bytes(64))),
            content + block[:-1],
            content + block + b'\n',
            content + block + block,
            content + b'<!-- sparkle-signatures:\nedSignature: x\n-->\n',
            content,
            # One item removed, or one injected, under the old signature.
            render([new_item('123.2', '1.2.3', SIGNATURE, 7, 1)]) + block,
            render([new_item('123.2', '1.2.3', SIGNATURE, 7, 1), item('100.1', '1.0.0'), item('99.1', '1.9.9')]) + block,
        ]
        # Content edits break the Ed25519 signature itself, not just our parser.
        self.assertFalse(independent_verify(*sparkle_extract(tampered[0])[:2], KEYS['DISPATCH_SPARKLE_PUBLIC_KEY']))
        for data in tampered:
            with self.assertRaisesRegex(ValueError, 'verify failed|Unsigned appcast'): parse(data)
        with patch.dict(os.environ, {'DISPATCH_SPARKLE_PUBLIC_KEY': OTHER_KEYS['DISPATCH_SPARKLE_PUBLIC_KEY']}):
            with self.assertRaisesRegex(ValueError, 'verify failed'): parse(signed)

    def test_signing_requires_the_matching_key(self):
        with patch.dict(os.environ, {'DISPATCH_SPARKLE_PUBLIC_KEY': OTHER_KEYS['DISPATCH_SPARKLE_PUBLIC_KEY']}):
            with self.assertRaisesRegex(ValueError, 'does not match'): appcast.sign(render([item('100.1')]))
        with patch.dict(os.environ, {'MACOS_SPARKLE_PRIVATE_KEY': ''}):
            with self.assertRaisesRegex(ValueError, 'private seed'): appcast.sign(render([item('100.1')]))

    def test_secret_never_reaches_argv_or_output(self):
        with patch.object(appcast.subprocess, 'run', wraps=subprocess.run) as run:
            signed = self.signed()
        for call in run.call_args_list:
            self.assertNotIn(KEYS['MACOS_SPARKLE_PRIVATE_KEY'], ' '.join(call.args[0]))
        self.assertNotIn(KEYS['MACOS_SPARKLE_PRIVATE_KEY'].encode(), signed)
        with patch.dict(os.environ, {'DISPATCH_SPARKLE_PUBLIC_KEY': OTHER_KEYS['DISPATCH_SPARKLE_PUBLIC_KEY']}):
            with self.assertRaises(ValueError) as failure: appcast.sign(render([item('100.1')]))
        self.assertNotIn(KEYS['MACOS_SPARKLE_PRIVATE_KEY'], str(failure.exception))

    def test_unsigned_baseline_still_parses_and_resigns(self):
        legacy = render([item('100.1', '1.0.0')])
        self.assertNotIn(b'sparkle-signatures', legacy)
        items = add(parse(legacy), new_item('101.1', '1.0.1', SIGNATURE, 7, 1))
        resigned = appcast.sign(render(items))
        self.assertEqual(parse(resigned), sorted(items, key=lambda i: build_version(i['build']), reverse=True))

    @unittest.skipUnless(os.environ.get('DISPATCH_SPARKLE_SDK'), 'official sign_update not available')
    def test_official_sign_update_verifies_the_feed(self):
        tool = Path(os.environ['DISPATCH_SPARKLE_SDK']) / 'bin/sign_update'
        with tempfile.TemporaryDirectory(prefix='dispatch-appcast-', dir='/tmp') as directory:
            key, feed = Path(directory) / 'key', Path(directory) / 'appcast.xml'
            key.write_text(KEYS['MACOS_SPARKLE_PRIVATE_KEY'])
            feed.write_bytes(self.signed())
            self.assertEqual(subprocess.run([str(tool), '--verify', '--ed-key-file', str(key), str(feed)], capture_output=True).returncode, 0)
            feed.write_bytes(self.signed().replace(b'1.2.3', b'1.2.4'))
            self.assertNotEqual(subprocess.run([str(tool), '--verify', '--ed-key-file', str(key), str(feed)], capture_output=True).returncode, 0)
            # Ed25519 is deterministic: the official signer must produce identical bytes.
            content = render([new_item('123.2', '1.2.3', SIGNATURE, 7, 1)])
            feed.write_bytes(content)
            subprocess.run([str(tool), '--disable-signing-warning', '--ed-key-file', str(key), str(feed)], capture_output=True, check=True)
            self.assertEqual(feed.read_bytes(), appcast.sign(content))


@unittest.skipUnless(os.environ.get('DISPATCH_SPARKLE_SDK') and shutil.which('swiftc'), 'Sparkle SDK and swiftc required')
class RealSparkleTests(unittest.TestCase):
    """Drive the embedded Sparkle 2.10 SPUUpdater against served fixtures."""

    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='dispatch-sparkle-', dir='/tmp')
        root = Path(cls.scratch.name)
        sdk = os.environ['DISPATCH_SPARKLE_SDK']
        cls.probe = root / 'probe'
        subprocess.run(['swiftc', '-F', sdk, '-framework', 'Sparkle', '-Xlinker', '-rpath', '-Xlinker', sdk,
                        str(appcast.ROOT / 'scripts/sparkle-feed-probe.swift'), '-o', str(cls.probe)], check=True, capture_output=True)
        cls.www = root / 'www'
        cls.www.mkdir()
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args): pass
        handler = functools.partial(Quiet, directory=str(cls.www))
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        with patch.dict(os.environ, KEYS):
            content = render([new_item('200.1', '1.0.3', SIGNATURE, 7, 1), item('100.1', '1.0.0')])
            signed = appcast.sign(content)
        (cls.www / 'signed.xml').write_bytes(signed)
        (cls.www / 'tampered.xml').write_bytes(signed.replace(b'recoveryProtocol>1<', b'recoveryProtocol>2<', 1))
        (cls.www / 'stripped.xml').write_bytes(content)
        (cls.www / 'legacy.xml').write_bytes(render([item('100.1', '1.0.0')]))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.scratch.cleanup()

    def check(self, feed, strict):
        identifier = f'dev.bradharris.dispatch.feedprobe.{os.getpid()}.{feed}.{int(strict)}'
        app = Path(self.scratch.name) / f'{feed}-{int(strict)}.app'
        (app / 'Contents').mkdir(parents=True, exist_ok=True)
        info = {'CFBundleIdentifier': identifier, 'CFBundleVersion': '1.1', 'CFBundleShortVersionString': '1.0.1',
                'CFBundlePackageType': 'APPL', 'SUEnableAutomaticChecks': False, 'SUVerifyUpdateBeforeExtraction': True,
                'SUFeedURL': f'http://127.0.0.1:{self.server.server_address[1]}/{feed}.xml',
                'SUPublicEDKey': KEYS['DISPATCH_SPARKLE_PUBLIC_KEY']}
        if strict:
            info.update(SURequireSignedFeed=True, SUSignedFeedFailureExpirationInterval=0)
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        try:
            output = subprocess.run([str(self.probe), str(app)], capture_output=True, text=True, timeout=60).stdout
        finally:
            subprocess.run(['defaults', 'delete', identifier], capture_output=True)
        return [line for line in output.splitlines() if re.match(r'(feed|item|error)', line)]

    def test_installed_apps_without_signed_feeds_ignore_signature_and_capability(self):
        self.assertEqual(self.check('signed', False), [
            'feed status=0', 'item 200.1 recovery=1 keys=dispatch:recoveryProtocol,enclosure,title',
            'item 100.1 recovery=- keys=enclosure,title', 'error=none'])

    def test_signed_feed_apps_see_the_prefixed_capability_only_when_verified(self):
        self.assertEqual(self.check('signed', True), [
            'feed status=1', 'item 200.1 recovery=1 keys=dispatch:recoveryProtocol,enclosure,title',
            'item 100.1 recovery=- keys=enclosure,title', 'error=none'])
        for feed in ['tampered', 'stripped', 'legacy']:
            self.assertEqual(self.check(feed, True), ['error=1000'], feed)


class ChannelTests(unittest.TestCase):
    def test_new_builds_enter_preview_newest_first(self):
        items = add(add([], item('100.1', '1.0.0')), item('101.1', '1.0.1'))
        self.assertEqual([i['build'] for i in items], ['101.1', '100.1'])
        self.assertTrue(all(i['channel'] == 'preview' for i in items))

    def test_refuses_equal_or_older_builds(self):
        items = add([], item('100.1'))
        for build in ['100.1', '99.5']:
            with self.assertRaisesRegex(ValueError, 'not newer'): add(items, item(build, '1.0.1'))

    def test_rerun_of_a_release_replaces_its_build(self):
        items = add(add([], item('100.1', '1.0.0')), item('100.2', '1.0.0'))
        self.assertEqual([i['build'] for i in items], ['100.2'])

    def test_keeps_a_bounded_history(self):
        items = []
        for n in range(appcast.KEEP + 3):
            items = add(items, item(f'{100 + n}.1', f'1.0.{n}'))
        self.assertEqual(len(items), appcast.KEEP)
        self.assertEqual(items[0]['build'], f'{100 + appcast.KEEP + 2}.1')

    def test_pruning_keeps_the_newest_stable_release(self):
        items = promote(add(add([], item('100.1', '1.0.0')), item('101.1', '1.0.1')), '1.0.1')
        items = promote(items, '1.0.0')
        for n in range(appcast.KEEP + 2):
            items = add(items, item(f'{200 + n}.1', f'1.1.{n}'))
        stable = [i for i in items if i['channel'] is None]
        self.assertEqual([i['version'] for i in stable], ['1.0.1'])
        self.assertEqual(len(items), appcast.KEEP + 1)

    def test_promote_untags_only_that_release(self):
        items = add(add([], item('100.1', '1.0.0')), item('101.1', '1.0.1'))
        promoted = promote(items, '1.0.0')
        self.assertEqual({i['version']: i['channel'] for i in promoted}, {'1.0.0': None, '1.0.1': 'preview'})
        element = ET.fromstring(render(promoted)).findall('./channel/item')[1]
        self.assertIsNone(element.find(f'{{{NS}}}channel'))
        with self.assertRaisesRegex(ValueError, 'not in the appcast'): promote(items, '2.0.0')


class PublicationTests(unittest.TestCase):
    def test_only_a_confirmed_404_starts_empty(self):
        with patch.object(appcast, 'urlopen', side_effect=HTTPError('https://test', 404, 'Missing', {}, None)) as open_url:
            self.assertEqual(appcast.current_items(), [])
            self.assertEqual(open_url.call_args.args[0].get_header('User-agent'), 'Dispatch-Update-Publisher/1.0')
        with patch.object(appcast, 'urlopen', side_effect=HTTPError('https://test', 503, 'Unavailable', {}, None)):
            with self.assertRaises(HTTPError): appcast.current_items()

    def test_verification_is_required(self):
        with patch.object(appcast, 'fetch_public', return_value=None), patch.object(appcast.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'verification failed'):
                appcast.verify(render([item('100.1')]))

    @patch.dict(os.environ, KEYS)
    def test_deploy_replaces_generated_assets_with_the_current_feed(self):
        items = promote([item('100.1'), item('101.1', '1.0.1')], '1.0.0')
        with tempfile.TemporaryDirectory(prefix='dispatch-appcast-', dir='/tmp') as directory:
            root = Path(directory)
            dist = root / 'apps/update-feeds/dist'
            retired = dist / 'updates/macos/preview/appcast-arm64.xml'
            retired.parent.mkdir(parents=True)
            retired.write_bytes(b'old feed')
            real_run = subprocess.run
            wrangler = []
            def run(command, **kwargs):
                if command[0] == 'node':
                    return real_run(command, **kwargs)
                wrangler.append(command)
            with patch.object(appcast, 'ROOT', root), patch.object(appcast.subprocess, 'run', side_effect=run), patch.object(appcast, 'verify') as verify:
                appcast.deploy(items)
            self.assertEqual(len(wrangler), 1)
            built = dist / appcast.FEED_PATH.lstrip('/')
            # The deployed bytes are signed before deploy and verified byte-for-byte.
            self.assertEqual(sparkle_extract(built.read_bytes())[0], render(items))
            verify.assert_called_once_with(built.read_bytes())
            self.assertEqual(parse(built.read_bytes()), sorted(items, key=lambda i: build_version(i['build']), reverse=True))
            self.assertEqual({str(path.relative_to(dist)) for path in dist.rglob('*') if path.is_file()},
                             {appcast.FEED_PATH.lstrip('/'), '_headers'})

    def test_release_workflow_contract(self):
        workflow = (appcast.ROOT / '.github/workflows/release.yml').read_text()
        self.assertIn('tags: ["v*.*.*"]', workflow)
        self.assertIn('group: dispatch-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('${{ github.run_id }}.${{ github.run_attempt }}', workflow)
        self.assertIn('https://dispatch.berad.dev/updates/macos/appcast-arm64.xml', workflow)
        self.assertIn('macos_appcast.py publish', workflow)
        self.assertLess(workflow.index('Download verified Sparkle SDK'), workflow.index('Test appcast publisher'))
        self.assertLess(workflow.index('Sign, notarize, and verify app'), workflow.index('Sign archive'))
        promote_workflow = (appcast.ROOT / '.github/workflows/promote-release.yml').read_text()
        self.assertIn('group: dispatch-release', promote_workflow)
        self.assertIn("github.ref == 'refs/heads/main'", promote_workflow)
        self.assertIn('macos_appcast.py promote', promote_workflow)
        self.assertIn('--archives "$RUNNER_TEMP/macos"', promote_workflow)
        self.assertLess(promote_workflow.index('gh release download'), promote_workflow.index('macos_appcast.py promote'))
        # Both feed writers sign with the existing secret, passed only via env.
        for text, command in [(workflow, 'macos_appcast.py publish'), (promote_workflow, 'macos_appcast.py promote')]:
            step = text[text.index(command):]
            step = step[:step.index('\n      - ')] if '\n      - ' in step else step
            self.assertIn('MACOS_SPARKLE_PRIVATE_KEY: ${{ secrets.MACOS_SPARKLE_PRIVATE_KEY }}', step)
            self.assertIn('DISPATCH_SPARKLE_PUBLIC_KEY: ${{ vars.MACOS_SPARKLE_PUBLIC_KEY }}', step)
            self.assertNotIn('MACOS_SPARKLE_PRIVATE_KEY', step.split('env:')[0])
        build = (appcast.ROOT / 'scripts/build-macos-app.mjs').read_text()
        for key in ['"SURequireSignedFeed"', '"SUVerifyUpdateBeforeExtraction"', '"SUSignedFeedFailureExpirationInterval"']:
            self.assertIn(key, build)
        site = (appcast.ROOT / '.github/workflows/deploy-site.yml').read_text()
        self.assertNotIn('update-feeds', site)


if __name__ == '__main__': unittest.main()
