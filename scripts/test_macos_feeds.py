#!/usr/bin/env python3
import base64
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import macos_feeds as feeds
from macos_dogfood import archive_name, authorize_channel, feed, publish

SIGNATURE = base64.b64encode(bytes(64)).decode()


def candidate(build, channel='preview'):
    return feed(build, '1.2.3', SIGNATURE, 7, channel)


class FeedTests(unittest.TestCase):
    def test_bootstrap_keeps_stable_empty(self):
        with patch.object(feeds, 'release', return_value=None), patch.object(feeds, 'fetch_public', return_value=None):
            result = feeds.assemble('preview', candidate('100.1'))
        self.assertEqual(feeds.revision(result['stable']), (0, 0))
        self.assertEqual(feeds.revision(result['preview']), (100, 1))

    def test_preview_preserves_stable_bytes(self):
        stable = candidate('90.1', 'stable')
        with patch.object(feeds, 'recovery_feed', return_value=stable), patch.object(feeds, 'fetch_public', side_effect=[candidate('99.1'), stable]):
            result = feeds.assemble('preview', candidate('100.1'))
        self.assertEqual(result['stable'], stable)

    def test_stable_preserves_preview_bytes(self):
        preview = candidate('99.1')
        with patch.object(feeds, 'recovery_feed', return_value=preview), patch.object(feeds, 'fetch_public', side_effect=[preview, feeds.empty_feed()]):
            result = feeds.assemble('stable', candidate('100.1', 'stable'))
        self.assertEqual(result['preview'], preview)
        self.assertEqual(feeds.revision(result['stable']), (100, 1))

    def test_domain_newer_than_recovery_is_never_rolled_back(self):
        with patch.object(feeds, 'recovery_feed', return_value=feeds.empty_feed()), patch.object(feeds, 'fetch_public', side_effect=[candidate('99.1'), candidate('98.1', 'stable')]):
            with self.assertRaisesRegex(ValueError, 'stable: refusing'):
                feeds.assemble('preview', candidate('100.1'))

    def test_equal_build_different_metadata_rejected(self):
        changed = feed('100.1', '1.2.4', SIGNATURE, 7)
        with patch.object(feeds, 'fetch_public', return_value=candidate('100.1')):
            with self.assertRaisesRegex(ValueError, 'different'):
                feeds.assemble('preview', changed)

    def test_network_failure_does_not_bootstrap(self):
        with patch.object(feeds, 'urlopen', side_effect=HTTPError('https://test', 503, 'Unavailable', {}, None)):
            with self.assertRaises(HTTPError): feeds.fetch_public('stable')

    def test_publisher_identifies_itself_to_domain(self):
        with patch.object(feeds, 'urlopen', side_effect=HTTPError('https://test', 404, 'Missing', {}, None)) as open_url:
            self.assertIsNone(feeds.fetch_public('preview'))
            self.assertEqual(open_url.call_args.args[0].get_header('User-agent'), 'Dispatch-Update-Publisher/1.0')

    def test_missing_recovery_asset_is_not_empty_stable(self):
        with patch.object(feeds, 'release', return_value={'assets': []}):
            with self.assertRaisesRegex(RuntimeError, 'repair interrupted'):
                feeds.recovery_feed('stable')

    def test_domain_failure_leaves_legacy_bridge_untouched(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            (directory / archive_name('100.1')).write_bytes(b'archive')
            (directory / 'appcast-arm64.xml').write_bytes(candidate('100.1'))
            old = {'id': 1, 'name': 'appcast-arm64.xml'}
            archive = {'id': 2, 'name': archive_name('100.1')}
            staged = {'id': 3, 'name': 'appcast-arm64-100.1.xml'}
            with patch('macos_dogfood.release', side_effect=[{'assets': [old]}, None, {'assets': [archive]}, {'assets': [old, staged]}]), patch('macos_dogfood.asset_data', side_effect=[candidate('99.1'), b'archive', candidate('100.1')]), patch('macos_dogfood.gh') as gh, patch('macos_dogfood.rename') as rename:
                def failed(*args): raise RuntimeError('domain failed')
                with self.assertRaisesRegex(RuntimeError, 'domain failed'):
                    publish(directory, '100.1', 'a' * 40, deploy_feeds=failed)
                rename.assert_not_called()
                self.assertEqual(gh.call_count, 2)  # archive + retained candidate; no live rename

    def test_domain_verification_is_required(self):
        with patch.object(feeds, 'fetch_public', return_value=None), patch.object(feeds.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'verification failed'):
                feeds.verify({'preview': candidate('100.1')})

    def test_stable_requires_explicit_main_dispatch(self):
        for ref, event in [('refs/heads/acp-runtime', 'workflow_dispatch'), ('refs/heads/main', 'push'), ('', '')]:
            with patch.dict(os.environ, {'GITHUB_REF': ref, 'GITHUB_EVENT_NAME': event}):
                with self.assertRaisesRegex(ValueError, 'explicit dispatch'):
                    authorize_channel('stable')
        with patch.dict(os.environ, {'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch'}):
            authorize_channel('stable')

    def test_workflow_channel_boundaries(self):
        workflow = (feeds.ROOT / '.github/workflows/macos-dogfood.yml').read_text()
        self.assertIn("github.ref == 'refs/heads/main'", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)
        self.assertIn('options: [preview, stable]', workflow)
        self.assertIn('https://dispatch.berad.dev/updates/macos/', workflow)
        self.assertIn('--deploy-feeds', workflow)
        self.assertEqual(workflow.count('CLOUDFLARE_API_TOKEN:'), 1)
        site = (feeds.ROOT / '.github/workflows/deploy-site.yml').read_text()
        self.assertNotIn('update-feeds', site)


if __name__ == '__main__': unittest.main()
