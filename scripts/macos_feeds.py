#!/usr/bin/env python3
"""Publish a complete static feed deployment, independently of the website.

GitHub retains recovery copies; the public appcasts are static Cloudflare assets.
All writers use the macos-acp-runtime-publish workflow concurrency group.
"""
from pathlib import Path
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from macos_dogfood import FEED_TAGS, asset_data, feed_version, release

ROOT = Path(__file__).resolve().parent.parent
ORIGIN = 'https://dispatch.berad.dev'


def feed_path(channel):
    if channel not in FEED_TAGS:
        raise ValueError('Unknown update channel')
    return f'/updates/macos/{channel}/appcast-arm64.xml'


def empty_feed():
    # A valid channel with no releases: stable is not published by merging a branch.
    return b'<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Dispatch Stable (arm64)</title></channel></rss>'


def revision(data):
    root = ET.fromstring(data)
    if root.tag == 'rss' and root.get('version') == '2.0' and len(root.findall('channel')) == 1 and not root.findall('./channel/item'):
        return (0, 0)
    return feed_version(data)


def fetch_public(channel):
    try:
        request = Request(ORIGIN + feed_path(channel), headers={'Cache-Control': 'no-cache', 'User-Agent': 'Dispatch-Update-Publisher/1.0'})
        with urlopen(request, timeout=30) as response:
            return response.read(1024 * 1024)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise


def recovery_feed(channel):
    current = release(FEED_TAGS[channel])
    if current is None:
        if channel == 'stable':
            return empty_feed()
        raise RuntimeError('Preview recovery feed is missing')
    asset = next((a for a in current['assets'] if a['name'] == 'appcast-arm64.xml'), None)
    if asset is None:
        raise RuntimeError(f'{channel}: missing recovery feed; repair interrupted GitHub promotion first')
    return asset_data(asset)


def assemble(channel, candidate):
    """Keep both channels; never roll a live feed backward or change equal builds."""
    feed_path(channel)
    feed_version(candidate)
    feeds = {}
    for name in FEED_TAGS:
        data = candidate if name == channel else recovery_feed(name)
        proposed = revision(data)
        if name == 'preview' and proposed == (0, 0):
            raise ValueError('Preview must contain a release')
        live = fetch_public(name)
        if live is not None:
            current = revision(live)
            if proposed < current or (proposed == current and data != live):
                raise ValueError(f'{name}: refusing to overwrite newer or different live feed; reconcile recovery copy')
        feeds[name] = data
    return feeds


def verify(feeds):
    # Wait only for bounded deployment propagation. Failure leaves the GitHub
    # bridge untouched; a later run can reconcile from retained release assets.
    for attempt in range(12):
        try:
            if all(fetch_public(name) == data for name, data in feeds.items()):
                return
        except (OSError, HTTPError):
            pass
        if attempt < 11:
            time.sleep(5)
    raise RuntimeError('Public feed verification failed; GitHub bridge was not promoted')


def deploy(channel, candidate):
    feeds = assemble(channel, candidate)
    directory = ROOT / 'apps/update-feeds/dist'
    directory.mkdir(parents=True, exist_ok=True)
    for name, data in feeds.items():
        target = directory / feed_path(name).lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (directory / '_headers').write_text('/updates/*\n  Cache-Control: no-cache, max-age=0, must-revalidate\n  Content-Type: application/xml; charset=utf-8\n  X-Content-Type-Options: nosniff\n')
    subprocess.run(['pnpm', '--filter', '@dispatch/site', 'exec', 'wrangler', 'deploy', '--config', str(ROOT / 'apps/update-feeds/wrangler.jsonc')], cwd=ROOT, check=True)
    verify(feeds)
