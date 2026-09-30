import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from sparkle_proof_cleanup import TLS_CONFIG, assert_restore, assert_failed_startup, cleanup_certificate, cleanup_phases, cleanup_service, final_verdict

class CleanupTests(unittest.TestCase):
    def test_failed_target_retains_intent_without_health_confirmation(self):
        pending={'wasRunning':True,'targetBuild':'2'}
        rows=[{'build':'1','event':'ready'},
              {'build':'2','event':'service-registered'},
              {'build':'2','event':'error','details':'Probe service failed readiness','pid':20}]
        self.assertEqual(assert_failed_startup(rows,pending,'2')['pid'],20)
        for event in ['ready','restore-acknowledged','upgrade-confirmed']:
            with self.assertRaises(AssertionError):
                assert_failed_startup(rows+[{'build':'2','event':event}],pending,'2')
        for wrong in [{},{'wasRunning':False,'targetBuild':'2'},{'wasRunning':True,'targetBuild':'1'}]:
            with self.assertRaises(AssertionError): assert_failed_startup(rows,wrong,'2')
        with self.assertRaises(AssertionError): assert_failed_startup(rows,pending,'1')
        with self.assertRaises(AssertionError): assert_failed_startup(rows[:-1],pending,'2')
        with self.assertRaises(AssertionError): assert_failed_startup(rows+[rows[-1]],pending,'2')
        with self.assertRaises(AssertionError): assert_failed_startup(rows[2:],pending,'2')

    def test_stale_restore_rejected(self):
        rows=[{'build':'2','event':'restore-requested','details':'new'}, {'build':'2','event':'restore-acknowledged','details':'new'}]
        for runtime in [{'requestID':'old','phase':'stopped'}, {'requestID':'new','phase':'running'}]:
            with self.assertRaises(AssertionError): assert_restore(rows,runtime,False)
        self.assertEqual(assert_restore(rows,{'requestID':'new','phase':'stopped'},False)['requestID'],'new')
        with self.assertRaises(AssertionError): assert_restore(rows[:1],{'requestID':'new','phase':'stopped'},False)

    def test_recovery_requires_fresh_process_acknowledgment(self):
        rows=[{'build':'1','pid':10,'event':'restore-requested','details':'old'},
              {'build':'1','pid':10,'event':'restore-acknowledged','details':'old'},
              {'build':'1','pid':20,'event':'restore-requested','details':'new'}]
        with self.assertRaises(AssertionError):
            assert_restore(rows,{'requestID':'old','phase':'stopped'},False,build='1',pid=20)
        rows.append({'build':'1','pid':20,'event':'restore-acknowledged','details':'new'})
        self.assertEqual(assert_restore(rows,{'requestID':'new','phase':'stopped'},False,build='1',pid=20)['requestID'],'new')
        with self.assertRaises(AssertionError):
            assert_restore(rows,{'requestID':'new','phase':'stopped'},False)

    def test_certificate_generation(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'tls.cnf').write_text(TLS_CONFIG)
            subprocess.run(['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-config',str(root/'tls.cnf'),'-keyout',str(root/'key'),'-out',str(root/'cert')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

    def test_dead_gui_partial_event_and_disappearing_pid(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); app=root/'Proof.app'; active=[True]; calls=[]
            (root/'sparkle-events.jsonl').write_text(json.dumps({'pid':123})+'\n{"pid":')
            def run(*cmd,**kwargs):
                calls.append(cmd)
                if cmd[0]=='ps': return SimpleNamespace(stdout=str(app/'Contents/MacOS/DispatchMenu'),returncode=0)
                if cmd[0]=='open': active[0]=False
                return SimpleNamespace(stdout='',returncode=0 if active[0] else 1)
            def vanished(*args): raise ProcessLookupError()
            cleanup_service(run,app,root,'unique',501,kill=vanished)
            self.assertTrue(any(cmd[0]=='open' and cmd[-1]=='--probe-cleanup' for cmd in calls))
            # No event log at all still invokes cleanup for a registered service.
            (root/'sparkle-events.jsonl').unlink(); active[0]=True; calls.clear()
            cleanup_service(run,app,root,'unique',501,kill=vanished)
            self.assertTrue(any(cmd[0]=='open' for cmd in calls))

    def test_certificate_failures_are_independent_and_fail_closed(self):
        for failure in ['remove-trusted-cert','delete-certificate','certificate-present','trust-present','export-failed','empty-trust',None]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root=Path(folder); calls=[]
                def run(*cmd,**kwargs):
                    calls.append(cmd)
                    output=''; code=0
                    if cmd[0]=='/usr/bin/openssl': output='SHA1 Fingerprint=AB:CD'
                    if cmd[1]=='trust-settings-export' and failure in ['empty-trust','export-failed']:
                        return SimpleNamespace(returncode=1, stderr='SecTrustSettingsCreateExternalRepresentation: No Trust Settings were found.' if failure=='empty-trust' else 'permission denied')
                    if cmd[1]=='trust-settings-export':
                        Path(cmd[2]).write_bytes(plistlib.dumps({'trustList': {'ABCD':{}} if failure=='trust-present' else {}}))
                    if cmd[1]=='find-certificate' and failure=='certificate-present': output='SHA-1 hash: ABCD'
                    if cmd[1]==failure: code=1
                    return SimpleNamespace(stdout=output,returncode=code)
                action=lambda: cleanup_certificate(run,root/'cert',root/'keychain',root)
                if failure and failure != 'empty-trust':
                    with self.assertRaises(RuntimeError): action()
                else: action()
                self.assertTrue(any(c[1]=='delete-certificate' for c in calls))
                self.assertTrue(any(c[1]=='trust-settings-export' for c in calls))

    def test_cleanup_failure_overrides_pass_and_continues(self):
        calls=[]
        def fail(): raise RuntimeError('service remains')
        errors=cleanup_phases([('service',fail),('certificate',lambda: calls.append('removed'))])
        self.assertEqual(calls,['removed'])
        self.assertEqual(final_verdict({'lifecycle':'passed'},errors)['result'],'failed')
        self.assertEqual(final_verdict({'lifecycle':'passed'},[])['result'],'passed')
        self.assertEqual(final_verdict({'lifecycle':'failed'},[])['result'],'failed')

if __name__=='__main__': unittest.main()
