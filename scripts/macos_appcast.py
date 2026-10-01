#!/usr/bin/env python3
"""Maintain the macOS Sparkle appcast. No network at import time.

One appcast lists recent builds. A new release enters tagged with the Sparkle
`preview` channel; promoting it removes the tag, so stable apps (which allow no
extra channels) see it too. Each archive is an asset on its `vX.Y.Z` GitHub
release, and the appcast is served as a static Cloudflare asset.

All writers share the `dispatch-release` workflow concurrency group.
"""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

REPO = 'selfcontained/dispatch'
ORIGIN = 'https://dispatch.berad.dev'
FEED_PATH = '/updates/macos/appcast-arm64.xml'
# Apps built before 1.0 follow this path and know nothing of channels. It
# serves only the newest build, untagged, so they update once onto an app
# that follows FEED_PATH.
LEGACY_PATH = '/updates/macos/preview/appcast-arm64.xml'
PREVIEW = 'preview'
KEEP = 10
NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle'
ET.register_namespace('sparkle', NS)
ROOT = Path(__file__).resolve().parent.parent


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


def new_item(build, version, signature, length):
    build_version(build)
    short_version(version)
    if len(base64.b64decode(signature, validate=True)) != 64 or length <= 0:
        raise ValueError('Invalid signature or archive length')
    return {'build': build, 'version': version, 'signature': signature, 'length': length, 'channel': PREVIEW}


def parse(data):
    root = ET.fromstring(data)
    if root.tag != 'rss' or root.get('version') != '2.0' or len(root.findall('channel')) != 1:
        raise ValueError('Invalid appcast schema')
    items = []
    for element in root.findall('./channel/item'):
        enclosure = element.find('enclosure')
        if enclosure is None:
            raise ValueError('Appcast item has no enclosure')
        item = new_item(
            element.findtext(f'{{{NS}}}version', ''),
            element.findtext(f'{{{NS}}}shortVersionString', ''),
            enclosure.get(f'{{{NS}}}edSignature', ''),
            int(enclosure.get('length', '0')),
        )
        item['channel'] = element.findtext(f'{{{NS}}}channel')
        if item['channel'] not in (None, PREVIEW):
            raise ValueError(f'Unknown channel {item["channel"]!r}')
        if enclosure.get('url') != archive_url(item):
            raise ValueError(f'Unexpected archive URL for {item["build"]}')
        items.append(item)
    return items


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
    return recent


def promote(items, version):
    short_version(version)
    matched = [i for i in items if i['version'] == version]
    if not matched:
        raise ValueError(f'{version} is not in the appcast')
    return [{**i, 'channel': None} if i['version'] == version else i for i in items]


def legacy(items):
    if not items:
        raise ValueError('Appcast is empty')
    newest = max(items, key=lambda i: build_version(i['build']))
    return render([{**newest, 'channel': None}])


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


def verify(feeds):
    for attempt in range(12):
        try:
            if all(fetch_public(path) == data for path, data in feeds.items()):
                return
        except (OSError, HTTPError):
            pass
        if attempt < 11:
            time.sleep(5)
    raise RuntimeError('Public appcast verification failed')


def deploy(items):
    feeds = {FEED_PATH: render(items), LEGACY_PATH: legacy(items)}
    directory = ROOT / 'apps/update-feeds/dist'
    directory.mkdir(parents=True, exist_ok=True)
    for path, data in feeds.items():
        target = directory / path.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (directory / '_headers').write_text('/updates/*\n  Cache-Control: no-cache, max-age=0, must-revalidate\n  Content-Type: application/xml; charset=utf-8\n  X-Content-Type-Options: nosniff\n')
    subprocess.run(['pnpm', '--filter', '@dispatch/site', 'exec', 'wrangler', 'deploy', '--config', str(ROOT / 'apps/update-feeds/wrangler.jsonc')], cwd=ROOT, check=True)
    verify(feeds)


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
    args = parser.parse_args()
    if args.action == 'item':
        archive = args.directory / archive_name(args.build)
        signature = (args.directory / 'signature.txt').read_text().strip()
        described = new_item(args.build, args.version, signature, archive.stat().st_size)
        (args.directory / 'macos-item.json').write_text(json.dumps(described) + '\n')
    elif args.action == 'publish':
        described = json.loads(args.item.read_text())
        deploy(add(current_items(), new_item(described['build'], described['version'], described['signature'], described['length'])))
    else:
        deploy(promote(current_items(), args.version))


if __name__ == '__main__':
    main()
