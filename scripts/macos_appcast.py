#!/usr/bin/env python3
"""Maintain the macOS Sparkle appcast. No network at import time.

One appcast lists recent builds. A new release enters tagged with the Sparkle
`preview` channel; promoting it removes the tag, so stable apps (which allow no
extra channels) see it too. Each archive is an asset on its `vX.Y.Z` GitHub
release, and the appcast is served as a static Cloudflare asset.

All writers share the `dispatch-release` workflow concurrency group.

The feed is signed in Sparkle 2.10's native format before it is deployed;
bundled apps set SURequireSignedFeed, so every item (including its
`dispatch:recoveryProtocol` capability) is authenticated before the app acts on
it. Older apps ignore the trailing signature comment and the dispatch element.

Once a build with SURequireSignedFeed ships, every later publish must be signed
with the same MACOS_SPARKLE_PRIVATE_KEY: signing or self-verification failure
fails the release (there is no unsigned fallback), and losing that key means
those installs can never see another update. An unsigned live feed is reused
only as the pre-signing baseline, and only if no entry declares a recovery
protocol: a capability is never re-signed from unauthenticated data.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import plistlib
import zipfile
import re
import shutil
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

REPO = 'selfcontained/dispatch'
ORIGIN = 'https://dispatch.berad.dev'
FEED_PATH = '/updates/macos/appcast-arm64.xml'
PREVIEW = 'preview'
KEEP = 10
NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle'
ET.register_namespace('sparkle', NS)
# Sparkle exposes non-Sparkle item elements by qualified name, so the app reads
# propertiesDictionary["dispatch:recoveryProtocol"]: keep this exact prefix.
DISPATCH_NS = 'https://dispatch.berad.dev/xml-namespaces/update'
ET.register_namespace('dispatch', DISPATCH_NS)
RECOVERY = f'{{{DISPATCH_NS}}}recoveryProtocol'
RECOVERY_PROTOCOLS = (1,)
SIGNATURE_PREFIX = b'<!-- sparkle-signatures:\n'
# Migration switch: flip to True in the PR after the first signed feed is live,
# so an unsigned live feed (a stripped signature) can never be reused again.
REQUIRE_SIGNED_LIVE_FEED = False
ROOT = Path(__file__).resolve().parent.parent
FEED_SIGNER = Path(__file__).resolve().parent / 'sparkle-feed-signature.mjs'


def build_version(value):
    """CFBundleVersion is github.run_id.run_attempt, compared as integers."""
    if not re.fullmatch(r'[1-9][0-9]*\.[1-9][0-9]*', value):
        raise ValueError('Build must be run_id.run_attempt, both positive integers')
    return tuple(map(int, value.split('.')))


def short_version(value):
    if not re.fullmatch(r'[1-9][0-9]*\.[0-9]+\.[0-9]+', value):
        raise ValueError('Release version must be X.Y.Z with X >= 1')
    return value


def archive_name(build):
    build_version(build)
    return f'dispatch-macos-{build}-arm64.zip'


def archive_url(item):
    return f'https://github.com/{REPO}/releases/download/v{item["version"]}/{archive_name(item["build"])}'


def recovery_protocol(value):
    """None means the build declares no recovery capability; never invent one."""
    if value is None:
        return None
    if type(value) is not int or value not in RECOVERY_PROTOCOLS:
        raise ValueError(f'Unknown recovery protocol {value!r}')
    return value


def new_item(build, version, signature, length, recovery=None):
    build_version(build)
    short_version(version)
    if len(base64.b64decode(signature, validate=True)) != 64 or length <= 0:
        raise ValueError('Invalid signature or archive length')
    return {'build': build, 'version': version, 'signature': signature, 'length': length, 'channel': PREVIEW,
            'recoveryProtocol': recovery_protocol(recovery)}


def archive_protocol(archive, build, version):
    """The recovery protocol the archived app declares, or None if it declares none."""
    with zipfile.ZipFile(archive) as bundle:
        info = plistlib.loads(bundle.read('Dispatch.app/Contents/Info.plist'))
    if info.get('CFBundleVersion') != build or info.get('CFBundleShortVersionString') != version:
        raise ValueError('Info.plist version does not match the release build')
    return recovery_protocol(info.get('DispatchRecoveryProtocol'))


def app_item(archive, build, version, signature):
    """Describe a new archive from the app inside it, not from the release inputs."""
    declared = archive_protocol(archive, build, version)
    if declared is None:
        raise ValueError('Info.plist has no DispatchRecoveryProtocol')
    return new_item(build, version, signature, archive.stat().st_size, declared)


def verify_archive(item, archive):
    """A promoted entry must still describe its released artifact exactly."""
    if archive.stat().st_size != item['length']:
        raise ValueError(f'Archive length does not match {item["build"]}')
    feed_signature('verify-archive', b'', archive, item['signature'])
    # Legacy entries promote only if their app truly declares nothing.
    if archive_protocol(archive, item['build'], item['version']) != item['recoveryProtocol']:
        raise ValueError(f'Recovery protocol does not match the {item["build"]} archive')


def check_capability(items):
    """Once a build declares a recovery protocol, every newer build must too."""
    declared = False
    for item in sorted(items, key=lambda i: build_version(i['build'])):
        if item['recoveryProtocol'] is not None:
            declared = True
        elif declared:
            raise ValueError(f'{item["build"]} is newer than a recovery-capable build but declares no protocol')
    return items


def feed_signature(mode, data, *args):
    """Sign or verify through the Node helper; keys stay in the environment."""
    result = subprocess.run(['node', str(FEED_SIGNER), mode, *map(str, args)], input=data,
                            capture_output=True, env=os.environ.copy())
    if result.returncode != 0:
        raise ValueError(f'Appcast feed {mode} failed: {result.stderr.decode(errors="replace").strip()}')
    return result.stdout


def sign(data):
    signed = feed_signature('sign', data)
    if not signed.startswith(data) or signed[len(data):].count(SIGNATURE_PREFIX) != 1:
        raise ValueError('Unexpected signed appcast layout')
    feed_signature('verify', signed)
    return signed


def parse(data):
    at = data.rfind(SIGNATURE_PREFIX)
    if at >= 0:
        # A signed feed must verify against the configured key; never fold a
        # tampered feed into the next signature.
        feed_signature('verify', data)
        data = data[:at]
    signed = at >= 0
    if not signed and REQUIRE_SIGNED_LIVE_FEED:
        raise ValueError('Live appcast is unsigned')
    root = ET.fromstring(data)
    if root.tag != 'rss' or root.get('version') != '2.0' or len(root.findall('channel')) != 1:
        raise ValueError('Invalid appcast schema')
    items = []
    for element in root.findall('./channel/item'):
        enclosure = element.find('enclosure')
        if enclosure is None:
            raise ValueError('Appcast item has no enclosure')
        declared = element.findall(RECOVERY)
        if len(declared) > 1 or any(child.tag.startswith(f'{{{DISPATCH_NS}}}') and child.tag != RECOVERY for child in element):
            raise ValueError('Unexpected Dispatch appcast metadata')
        recovery = None
        if declared:
            text = declared[0].text or ''
            if not re.fullmatch(r'[1-9][0-9]*', text) or len(declared[0]) or declared[0].attrib:
                raise ValueError(f'Malformed recovery protocol {text!r}')
            recovery = int(text)
        item = new_item(
            element.findtext(f'{{{NS}}}version', ''),
            element.findtext(f'{{{NS}}}shortVersionString', ''),
            enclosure.get(f'{{{NS}}}edSignature', ''),
            int(enclosure.get('length', '0')),
            recovery,
        )
        item['channel'] = element.findtext(f'{{{NS}}}channel')
        if item['channel'] not in (None, PREVIEW):
            raise ValueError(f'Unknown channel {item["channel"]!r}')
        if enclosure.get('url') != archive_url(item):
            raise ValueError(f'Unexpected archive URL for {item["build"]}')
        items.append(item)
    # Only the signing publisher writes capabilities, so an unsigned feed that
    # carries one has had its signature stripped.
    if not signed and any(i['recoveryProtocol'] is not None for i in items):
        raise ValueError('Unsigned appcast declares a recovery protocol')
    return check_capability(items)


def render(items):
    rss = ET.Element('rss', version='2.0')
    channel = ET.SubElement(rss, 'channel')
    ET.SubElement(channel, 'title').text = 'Dispatch (arm64)'
    for item in sorted(items, key=lambda i: build_version(i['build']), reverse=True):
        element = ET.SubElement(channel, 'item')
        ET.SubElement(element, 'title').text = f'Dispatch {item["version"]} ({item["build"]})'
        for key, value in [('version', item['build']), ('shortVersionString', item['version']), ('minimumSystemVersion', '13.0')]:
            ET.SubElement(element, f'{{{NS}}}{key}').text = value
        if item['channel']:
            ET.SubElement(element, f'{{{NS}}}channel').text = item['channel']
        if item.get('recoveryProtocol') is not None:
            ET.SubElement(element, RECOVERY).text = str(recovery_protocol(item['recoveryProtocol']))
        ET.SubElement(element, 'enclosure', {'url': archive_url(item), f'{{{NS}}}edSignature': item['signature'], 'length': str(item['length']), 'type': 'application/octet-stream'})
    return ET.tostring(rss, encoding='utf-8', xml_declaration=True)


def add(items, item):
    """A new build enters Preview. A rerun of the same release replaces its older build."""
    newest = max((build_version(i['build']) for i in items), default=(0, 0))
    if build_version(item['build']) <= newest:
        raise ValueError('Refusing to publish a build that is not newer than the live appcast')
    kept = [i for i in items if i['version'] != item['version']]
    ordered = sorted([item, *kept], key=lambda i: build_version(i['build']), reverse=True)
    recent = ordered[:KEEP]
    # Stable apps only see untagged entries: however many previews follow,
    # the newest promoted release must stay in the appcast.
    stable = next((i for i in ordered if i['channel'] is None), None)
    if stable is not None and stable not in recent:
        recent.append(stable)
    return check_capability(recent)


def promote(items, version):
    short_version(version)
    matched = [i for i in items if i['version'] == version]
    if not matched:
        raise ValueError(f'{version} is not in the appcast')
    return [{**i, 'channel': None} if i['version'] == version else i for i in items]


def fetch_public(path):
    try:
        request = Request(ORIGIN + path, headers={'Cache-Control': 'no-cache', 'User-Agent': 'Dispatch-Update-Publisher/1.0'})
        with urlopen(request, timeout=30) as response:
            return response.read(1024 * 1024)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def current_items():
    # Network, auth and schema failures propagate: never publish over a feed
    # that could not be read. Only a confirmed 404 starts an empty appcast.
    data = fetch_public(FEED_PATH)
    return [] if data is None else parse(data)


def verify(data):
    for attempt in range(12):
        try:
            live = fetch_public(FEED_PATH)
            # The host must serve the signed bytes untouched; check what clients get.
            if live == data:
                feed_signature('verify', live)
                return
        except (OSError, HTTPError):
            pass
        if attempt < 11:
            time.sleep(5)
    raise RuntimeError('Public appcast verification failed')


def deploy(items):
    data = sign(render(check_capability(items)))
    directory = ROOT / 'apps/update-feeds/dist'
    # This is a generated asset bundle; never carry retired feeds into a deploy.
    if directory.exists():
        shutil.rmtree(directory)
    target = directory / FEED_PATH.lstrip('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    (directory / '_headers').write_text('/updates/*\n  Cache-Control: no-cache, max-age=0, must-revalidate\n  Content-Type: application/xml; charset=utf-8\n  X-Content-Type-Options: nosniff\n')
    subprocess.run(['pnpm', '--filter', '@dispatch/site', 'exec', 'wrangler', 'deploy', '--config', str(ROOT / 'apps/update-feeds/wrangler.jsonc')], cwd=ROOT, check=True)
    verify(data)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    item = sub.add_parser('item', help='describe a signed archive for publication')
    item.add_argument('--directory', type=Path, required=True)
    item.add_argument('--build', required=True)
    item.add_argument('--version', required=True)
    publish = sub.add_parser('publish', help='add a build to Preview')
    publish.add_argument('--item', type=Path, required=True)
    promote_cmd = sub.add_parser('promote', help='move a release to Stable')
    promote_cmd.add_argument('--version', required=True)
    promote_cmd.add_argument('--archives', type=Path, required=True, help='directory holding the released archive')
    args = parser.parse_args()
    if args.action == 'item':
        archive = args.directory / archive_name(args.build)
        signature = (args.directory / 'signature.txt').read_text().strip()
        described = app_item(archive, args.build, args.version, signature)
        (args.directory / 'macos-item.json').write_text(json.dumps(described) + '\n')
    elif args.action == 'publish':
        described = json.loads(args.item.read_text())
        if set(described) != {'build', 'version', 'signature', 'length', 'channel', 'recoveryProtocol'}:
            raise ValueError('Unexpected macos-item.json fields')
        deploy(add(current_items(), new_item(described['build'], described['version'], described['signature'],
                                             described['length'], described['recoveryProtocol'])))
    else:
        items = current_items()
        for entry in items:
            if entry['version'] == args.version:
                verify_archive(entry, args.archives / archive_name(entry['build']))
        deploy(promote(items, args.version))


if __name__ == '__main__':
    main()
