import json
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from sparkle_proof_live import LiveAgentProof

class LiveProofTests(unittest.TestCase):
    def test_fake_engine_holds_then_completes_same_session(self):
        with tempfile.TemporaryDirectory(prefix='dispatch-macos-test-sparkle-service-unit-',dir='/tmp') as folder:
            root=Path(folder); fixture=root/'fake-acp.py'
            shutil.copy2(Path(__file__).parent/'fixtures/sparkle-acp.py',fixture)
            child=subprocess.Popen([sys.executable,str(fixture.resolve())],stdin=subprocess.PIPE,stdout=subprocess.PIPE,bufsize=0)
            def send(i,method,params):
                child.stdin.write((json.dumps({'jsonrpc':'2.0','id':i,'method':method,'params':params})+'\n').encode());child.stdin.flush()
            def receive():
                self.assertTrue(select.select([child.stdout],[],[],5)[0], 'Fixture response timed out')
                return json.loads(child.stdout.readline())
            try:
                send(1,'initialize',{}); self.assertEqual(receive()['result']['protocolVersion'],1)
                send(2,'session/new',{}); session=receive()['result']['sessionId']
                send(3,'session/prompt',{'sessionId':session,'prompt':[{'type':'text','text':'sparkle-hold'}]})
                deadline=time.monotonic()+5
                while not (root/'live-turn-started.json').exists():
                    self.assertLess(time.monotonic(),deadline);time.sleep(.01)
                self.assertEqual(json.loads((root/'live-turn-started.json').read_text())['sessionID'],session)
                self.assertFalse(select.select([child.stdout],[],[],.1)[0])
                (root/'release-live-turn').touch()
                update=receive();self.assertEqual(update['params']['sessionId'],session)
                self.assertEqual(update['params']['update']['content']['text'],'sparkle-held-turn-completed')
                self.assertEqual(receive()['id'],3)
                send(4,'session/prompt',{'sessionId':session,'prompt':[{'type':'text','text':'followup'}]})
                self.assertEqual(receive()['params']['update']['content']['text'],'sparkle-followup-completed')
                self.assertEqual(receive()['id'],4)
            finally:
                child.stdin.close();child.wait(timeout=5);child.stdout.close()

    def test_settled_rejects_partial_and_failed_turns(self):
        proof=LiveAgentProof(Path('/tmp/proof'),None,None);proof.agent_id='agt_test'
        entries=[{'block':None},{'block':{'turn':None}},{'block':{'turn':{'settled':False,'result':{'text':'done'}}}},{'block':{'turn':{'settled':True,'error':'failed','result':{'text':'done'}}}}]
        proof.api=lambda _: {'entries':entries}
        self.assertFalse(proof.settled('done'))
        entries.append({'block':{'turn':{'settled':True,'result':{'text':'done'}}}})
        self.assertTrue(proof.settled('done'))

    def test_lost_create_response_and_late_process_are_cleaned(self):
        root=Path('/tmp/dispatch-macos-test-sparkle-service-unit-cleanup')
        proof=LiveAgentProof(root,Path('/Applications/Proof.app'),None)
        archived=[]
        def api(path,method='GET',body=None):
            if method=='POST': raise TimeoutError('committed create, lost response')
            if method=='DELETE': archived.append(path);return {'status':'archiving'}
            return {'agents':[{'id':'agt_owned','name':'Sparkle live proof','cwd':str(root)},
                              {'id':'agt_unrelated','name':'Sparkle live proof','cwd':'/elsewhere'}]}
        proof.api=api
        with self.assertRaises(TimeoutError): proof.start()
        self.assertTrue(proof.creation_attempted);self.assertIsNone(proof.agent_id)
        proof.request_archive()
        self.assertEqual(archived,['/agents/agt_owned?cleanupWorktree=keep'])
        # A 202 and an empty process set do not establish producer shutdown.
        with self.assertRaises(RuntimeError): proof.cleanup()
        clock=[0.0];scans=[0];owned={};killed=[]
        def listing():
            scans[0]+=1
            # confirm_service_stopped and first cleanup scan see no processes.
            if scans[0]==3:
                owned.update({123:'start agent-host --state '+str(root/'agents/agt_owned'),
                              456:'start python '+str(root/'fake-acp.py')})
            return list(owned.items())+[(789,'unrelated-process')]
        proof.listing=listing;proof.process=lambda pid: owned.get(pid,'')
        proof.confirm_service_stopped()
        def kill(pid,sig): killed.append(pid);owned.pop(pid)
        with patch('sparkle_proof_live.os.kill',side_effect=kill), \
             patch('sparkle_proof_live.time.monotonic',side_effect=lambda:clock[0]), \
             patch('sparkle_proof_live.time.sleep',side_effect=lambda seconds:clock.__setitem__(0,clock[0]+seconds)):
            proof.cleanup()
        self.assertEqual(killed,[123,456]);self.assertGreater(scans[0],3)

    def test_surviving_launch_producer_prevents_cleanup_success(self):
        root=Path('/tmp/dispatch-macos-test-sparkle-service-unit-cleanup')
        proof=LiveAgentProof(root,Path('/Applications/Proof.app'),None)
        proof.creation_attempted=True
        proof.listing=lambda: [(123,'DispatchMenu --server --isolated-test '+str(root))]
        with self.assertRaises(RuntimeError): proof.confirm_service_stopped()
        with self.assertRaises(RuntimeError): proof.cleanup()

    def test_replaced_process_fails_continuity(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'host.pid').write_text('123')
            proof=LiveAgentProof(root,None,None);proof.directory=root;proof.host_pid=123
            proof.processes={123:'old start time and command'}
            proof.process=lambda _: 'new start time and command'
            with self.assertRaises(AssertionError): proof.assert_alive()

if __name__=='__main__': unittest.main()
