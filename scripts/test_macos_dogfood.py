#!/usr/bin/env python3
import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
from macos_dogfood import NS, archive_name, feed, feed_version, publish, version

SIGNATURE = base64.b64encode(bytes(64)).decode()

class MetadataTests(unittest.TestCase):
    def test_numeric_order(self):
        self.assertGreater(version('100.1'), version('99.99'))
        self.assertGreater(version('100.10'), version('100.9'))
        self.assertGreater(version('999999999999999999.1'), version('999999999999999998.99'))
        for bad in ['1', '1.0', '01.1', '1.1.1', '-1.1', '1.a', '1.1\n']:
            with self.assertRaises(ValueError): version(bad)

    def test_schema(self):
        data = feed('123.2', '1.2.3', SIGNATURE, 42)
        self.assertEqual(feed_version(data), (123, 2))
        item = ET.fromstring(data).find('./channel/item')
        self.assertEqual(item.findtext(f'{{{NS}}}minimumSystemVersion'), '13.0')
        self.assertEqual(item.findtext(f'{{{NS}}}shortVersionString'), '1.2.3')
        enclosure = item.find('enclosure')
        self.assertEqual(enclosure.get('url'), 'https://github.com/selfcontained/dispatch/releases/download/macos-acp-123-2/dispatch-macos-acp-123.2-arm64.zip')
        self.assertEqual(enclosure.get(f'{{{NS}}}edSignature'), SIGNATURE)
        self.assertEqual(enclosure.get('length'), '42')
        for data in [b'<rss/>', b'<rss version="2.0"><channel/></rss>', b'broken']:
            with self.assertRaises((ValueError, ET.ParseError)): feed_version(data)

    def test_bad_metadata(self):
        for signature, size in [('garbage', 1), (SIGNATURE, 0), (base64.b64encode(bytes(32)).decode(), 1)]:
            with self.assertRaises(ValueError): feed('123.1', '1.2.3', signature, size)
        with self.assertRaises(ValueError): feed('123.1', '<inject>', SIGNATURE, 1)

    def fixture(self, directory):
        archive = directory / archive_name('123.2')
        archive.write_bytes(b'archive')
        (directory / 'appcast-arm64.xml').write_bytes(feed('123.2', '1.2.3', SIGNATURE, 7))

    def test_old_run_never_mutates(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            self.fixture(directory)
            with patch('macos_dogfood.release', return_value={'assets': [{'id': 1, 'name': 'appcast-arm64.xml'}]}), patch('macos_dogfood.asset_data', return_value=feed('124.1', '1.2.3', SIGNATURE, 7)), patch('macos_dogfood.gh') as command:
                with self.assertRaisesRegex(ValueError, 'newer'): publish(directory, '123.2', 'a' * 40)
                command.assert_not_called()

    def test_promotion_failure_restores_old_feed(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            self.fixture(directory)
            old = {'id': 1, 'name': 'appcast-arm64.xml'}
            new = {'id': 2, 'name': 'appcast-arm64-123.2.xml'}
            archive = {'id': 3, 'name': archive_name('123.2')}
            releases = [{'assets': [old]}, None, {'assets': [archive]}, {'assets': [old, new]}]
            data = [feed('123.1', '1.2.3', SIGNATURE, 7), b'archive', (directory / 'appcast-arm64.xml').read_bytes()]
            with patch('macos_dogfood.release', side_effect=releases), patch('macos_dogfood.asset_data', side_effect=data), patch('macos_dogfood.gh'), patch('macos_dogfood.rename', side_effect=[None, RuntimeError('failure'), None]) as rename:
                with self.assertRaises(RuntimeError): publish(directory, '123.2', 'a' * 40)
                self.assertEqual(rename.call_args_list[-1].args, (old, 'appcast-arm64.xml'))

    def test_interrupted_promotion_fails_closed(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            self.fixture(directory)
            with patch('macos_dogfood.release', return_value={'assets': [{'id': 1, 'name': 'appcast-arm64-before-125.1.xml'}]}), patch('macos_dogfood.gh') as command:
                with self.assertRaisesRegex(RuntimeError, 'Interrupted'): publish(directory, '123.2', 'a' * 40)
                command.assert_not_called()

    def test_workflow_contract(self):
        workflow = (Path(__file__).resolve().parent.parent / '.github/workflows/macos-dogfood.yml').read_text()
        self.assertIn('branches: [acp-runtime]', workflow)
        self.assertNotIn('agt_e49fa225fda7/agent-25fda7', workflow)
        self.assertIn('workflow_dispatch:', workflow)
        self.assertIn('      - apps/**', workflow)
        paths = [line.strip()[2:].strip("\"' ") for line in workflow.splitlines() if line.strip().startswith("- ")]
        self.assertIn("!**/*.md", paths)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertEqual(workflow.count('contents: write'), 1)
        self.assertIn('needs: build', workflow)
        self.assertNotIn('DISPATCH_SPARKLE_PROBE_SDK', workflow)
        self.assertIn('${{ github.run_id }}.${{ github.run_attempt }}', workflow)
        self.assertLess(workflow.index('Sign, notarize, and verify app'), workflow.index('Sign archive and generate appcast'))
        self.assertLess(workflow.index('Sign archive and generate appcast'), workflow.index('actions/upload-artifact'))

    def test_initial_release(self):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            self.fixture(directory)
            new = {'id': 2, 'name': 'appcast-arm64-123.2.xml'}
            archive = {'id': 3, 'name': archive_name('123.2')}
            with patch('macos_dogfood.release', side_effect=[None, None, {'assets': [archive]}, {'assets': [new]}]), patch('macos_dogfood.asset_data', side_effect=[b'archive', (directory / 'appcast-arm64.xml').read_bytes()]), patch('macos_dogfood.gh') as command, patch('macos_dogfood.rename') as rename:
                publish(directory, '123.2', 'a' * 40)
                self.assertTrue(any('macos-acp-runtime' in c.args for c in command.call_args_list))
                rename.assert_called_once_with(new, 'appcast-arm64.xml')

if __name__ == '__main__': unittest.main()
