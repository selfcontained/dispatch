#!/usr/bin/env python3
"""Generate and promote the arm64 dogfood appcast. No network at import time."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET

REPO = 'selfcontained/dispatch'
FEED_TAG = 'macos-acp-runtime'
FEED_TAGS = {'preview': FEED_TAG, 'stable': 'macos-stable'}
NS = 'http://www.andymatuschak.org/xml-namespaces/sparkle'
ET.register_namespace('sparkle', NS)


def version(value):
    if not re.fullmatch(r'[1-9][0-9]*\.[1-9][0-9]*', value):
        raise ValueError('Build must be run_id.run_attempt, both positive integers')
    return tuple(map(int, value.split('.')))


def archive_name(build):
    version(build)
    return f'dispatch-macos-acp-{build}-arm64.zip'


def tag(build):
    version(build)
    return 'macos-acp-' + build.replace('.', '-')


def feed(build, short_version, signature, length, channel_name='preview'):
    if channel_name not in FEED_TAGS:
        raise ValueError('Unknown update channel')
    version(build)
    if len(base64.b64decode(signature, validate=True)) != 64 or length <= 0:
        raise ValueError('Invalid signature or archive length')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', short_version):
        raise ValueError('Invalid display version')
    rss = ET.Element('rss', version='2.0')
    channel = ET.SubElement(rss, 'channel')
    ET.SubElement(channel, 'title').text = f'Dispatch {channel_name.title()} (arm64)'
    item = ET.SubElement(channel, 'item')
    ET.SubElement(item, 'title').text = f'Dispatch {short_version} ({build}, {channel_name})'
    for key, value in [('version', build), ('shortVersionString', short_version), ('minimumSystemVersion', '13.0')]:
        ET.SubElement(item, f'{{{NS}}}{key}').text = value
    ET.SubElement(item, 'enclosure', {'url': f'https://github.com/{REPO}/releases/download/{tag(build)}/{archive_name(build)}', f'{{{NS}}}edSignature': signature, 'length': str(length), 'type': 'application/octet-stream'})
    return ET.tostring(rss, encoding='utf-8', xml_declaration=True)


def feed_version(data):
    root = ET.fromstring(data)
    if root.tag != 'rss' or root.get('version') != '2.0':
        raise ValueError('Invalid appcast schema')
    items = root.findall('./channel/item')
    if len(items) != 1:
        raise ValueError('Expected one current release')
    return version(items[0].findtext(f'{{{NS}}}version', ''))


def gh(*args):
    return subprocess.check_output(['gh', *map(str, args)])


def api(endpoint, *args):
    return json.loads(gh('api', endpoint, *args))


def release(name):
    # Distinguish a missing release from auth/network failures (fail closed).
    result = subprocess.run(['gh', 'api', f'repos/{REPO}/releases/tags/{name}', '--include'], capture_output=True, text=True)
    if result.returncode:
        if re.search(r'^HTTP/\S+ 404\b', result.stdout, re.M):
            return None
        raise RuntimeError('Release lookup failed; refusing publication')
    return json.loads(result.stdout.split('\r\n\r\n' if '\r\n\r\n' in result.stdout else '\n\n', 1)[1])


def asset_data(asset):
    return gh('api', f'repos/{REPO}/releases/assets/{asset["id"]}', '-H', 'Accept: application/octet-stream')


def rename(asset, name):
    api(f'repos/{REPO}/releases/assets/{asset["id"]}', '-X', 'PATCH', '-f', f'name={name}')


def authorize_channel(channel):
    if channel not in FEED_TAGS:
        raise ValueError('Unknown update channel')
    if channel == 'stable' and (os.environ.get('GITHUB_REF') != 'refs/heads/main' or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'):
        raise ValueError('Stable publication requires an explicit dispatch from main')


def publish(directory, build, commit, channel='preview', deploy_feeds=None):
    authorize_channel(channel)
    feed_tag = FEED_TAGS[channel]
    version(build)
    archive = directory / archive_name(build)
    candidate = (directory / 'appcast-arm64.xml').read_bytes()
    if feed_version(candidate) != version(build):
        raise ValueError('Candidate build mismatch')
    document = ET.fromstring(candidate)
    if document.findtext('./channel/title') != f'Dispatch {channel.title()} (arm64)':
        raise ValueError('Candidate channel mismatch')
    item = document.find('./channel/item')
    enclosure = item.find('enclosure')
    expected_url = f'https://github.com/{REPO}/releases/download/{tag(build)}/{archive.name}'
    if enclosure.get('url') != expected_url or int(enclosure.get('length')) != archive.stat().st_size:
        raise ValueError('Archive metadata mismatch')
    current = release(feed_tag)
    old = next((a for a in current['assets'] if a['name'] == 'appcast-arm64.xml'), None) if current else None
    if current and not old and any(a['name'].startswith('appcast-arm64-before-') for a in current['assets']):
        raise RuntimeError('Interrupted promotion: restore the retained feed before publishing')
    if old and version(build) <= feed_version(asset_data(old)):
        raise ValueError('Refusing to replace an equal or newer published build')
    # Immutable release assets: never clobber or reuse an existing version tag.
    if release(tag(build)):
        raise ValueError('Immutable version release already exists; rerun with a new attempt')
    gh('release', 'create', tag(build), archive, '--repo', REPO, '--target', commit, *(['--prerelease'] if channel == 'preview' else []), '--latest=false', '--title', f'Dispatch {channel.title()} {build}', '--notes', f'Arm64 {channel} channel. See docs/macos-dogfood.md.')
    uploaded = release(tag(build))
    remote = next(a for a in uploaded['assets'] if a['name'] == archive.name)
    if hashlib.sha256(asset_data(remote)).digest() != hashlib.sha256(archive.read_bytes()).digest():
        raise RuntimeError('Uploaded archive verification failed; feed untouched')
    if not current:
        gh('release', 'create', feed_tag, '--repo', REPO, '--target', commit, '--prerelease', '--latest=false', '--title', f'Dispatch {channel.title()} update feeds', '--notes', 'Mutable opt-in Sparkle feeds; version archives live in separate prereleases.')
    # Upload and verify before changing the live asset. GitHub offers no atomic
    # asset replacement: retain the old asset and restore its name on failure.
    with tempfile.TemporaryDirectory() as scratch:
        staged = Path(scratch) / f'appcast-arm64-{build}.xml'
        staged.write_bytes(candidate)
        gh('release', 'upload', feed_tag, staged, '--repo', REPO)
        current = release(feed_tag)
        new = next(a for a in current['assets'] if a['name'] == staged.name)
        if asset_data(new) != candidate:
            raise RuntimeError('Staged feed verification failed; live feed untouched')
        # Retain the candidate for recovery, then verify the domain before
        # advertising the bridge to existing GitHub-feed installations.
        if deploy_feeds:
            deploy_feeds(channel, candidate)
        if old:
            rename(old, f'appcast-arm64-before-{build}.xml')
        try:
            rename(new, 'appcast-arm64.xml')
        except Exception:
            if old:
                rename(old, 'appcast-arm64.xml')
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['generate', 'publish'])
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--build', required=True)
    parser.add_argument('--version')
    parser.add_argument('--commit')
    parser.add_argument('--channel', choices=FEED_TAGS, default='preview')
    parser.add_argument('--deploy-feeds', action='store_true')
    args = parser.parse_args()
    if args.action == 'generate':
        archive = args.directory / archive_name(args.build)
        signature = (args.directory / 'signature.txt').read_text().strip()
        (args.directory / 'appcast-arm64.xml').write_bytes(feed(args.build, args.version, signature, archive.stat().st_size, args.channel))
    else:
        if not args.commit or not re.fullmatch('[0-9a-f]{40}', args.commit):
            raise ValueError('Exact source commit required')
        deploy = None
        if args.deploy_feeds:
            from macos_feeds import deploy
        publish(args.directory, args.build, args.commit, args.channel, deploy)


if __name__ == '__main__':
    main()
