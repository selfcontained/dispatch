#!/usr/bin/env python3
import base64
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import xml.etree.ElementTree as ET

import macos_appcast as appcast
from macos_appcast import NS, add, archive_name, build_version, legacy, new_item, parse, promote, render

SIGNATURE = base64.b64encode(bytes(64)).decode()


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

    def test_promote_untags_only_that_release(self):
        items = add(add([], item('100.1', '1.0.0')), item('101.1', '1.0.1'))
        promoted = promote(items, '1.0.0')
        self.assertEqual({i['version']: i['channel'] for i in promoted}, {'1.0.0': None, '1.0.1': 'preview'})
        element = ET.fromstring(render(promoted)).findall('./channel/item')[1]
        self.assertIsNone(element.find(f'{{{NS}}}channel'))
        with self.assertRaisesRegex(ValueError, 'not in the appcast'): promote(items, '2.0.0')

    def test_legacy_feed_offers_the_newest_build_untagged(self):
        items = add(add([], item('100.1', '1.0.0')), item('101.1', '1.0.1'))
        entries = ET.fromstring(legacy(items)).findall('./channel/item')
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].findtext(f'{{{NS}}}version'), '101.1')
        self.assertIsNone(entries[0].find(f'{{{NS}}}channel'))


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
                appcast.verify({appcast.FEED_PATH: render([item('100.1')])})

    def test_deploy_writes_both_paths_before_verifying(self):
        items = [item('100.1')]
        with patch.object(appcast.subprocess, 'run') as run, patch.object(appcast, 'verify') as verify:
            appcast.deploy(items)
        run.assert_called_once()
        feeds = verify.call_args.args[0]
        self.assertEqual(set(feeds), {appcast.FEED_PATH, appcast.LEGACY_PATH})
        built = appcast.ROOT / 'apps/update-feeds/dist' / appcast.FEED_PATH.lstrip('/')
        self.assertEqual(built.read_bytes(), render(items))

    def test_release_workflow_contract(self):
        workflow = (appcast.ROOT / '.github/workflows/release.yml').read_text()
        self.assertIn("tags: ['v*.*.*']", workflow)
        self.assertIn('group: dispatch-release', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('${{ github.run_id }}.${{ github.run_attempt }}', workflow)
        self.assertIn('https://dispatch.berad.dev/updates/macos/appcast-arm64.xml', workflow)
        self.assertIn('macos_appcast.py publish', workflow)
        self.assertLess(workflow.index('Sign, notarize, and verify app'), workflow.index('Sign archive'))
        promote_workflow = (appcast.ROOT / '.github/workflows/promote-release.yml').read_text()
        self.assertIn('group: dispatch-release', promote_workflow)
        self.assertIn("github.ref == 'refs/heads/main'", promote_workflow)
        self.assertIn('macos_appcast.py promote', promote_workflow)
        site = (appcast.ROOT / '.github/workflows/deploy-site.yml').read_text()
        self.assertNotIn('update-feeds', site)


if __name__ == '__main__': unittest.main()
