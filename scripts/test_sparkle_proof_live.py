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
            child=subprocess.Popen([sys.executable,str(fixture)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,bufsize=0)
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

    def test_cleanup_discovers_partial_launch_and_targets_only_owned_pids(self):
        root=Path('/tmp/dispatch-macos-test-sparkle-service-unit-cleanup')
        proof=LiveAgentProof(root,None,None);proof.agent_id='agt_owned'
        owned={123:'start agent-host --state '+str(root/'agents/agt_owned'),456:'start python '+str(root/'fake-acp.py')}
        listing='123 agent-host --state '+str(root/'agents/agt_owned')+'\n456 python '+str(root/'fake-acp.py')+'\n789 unrelated-process'
        proof.run=lambda *args,**kwargs: SimpleNamespace(stdout=listing)
        proof.process=lambda pid: owned.get(pid,'')
        def offline(*args): raise OSError('API offline')
        proof.api=offline
        killed=[]
        def kill(pid,sig): killed.append(pid);owned.pop(pid)
        with patch('sparkle_proof_live.os.kill',side_effect=kill): proof.cleanup()
        self.assertEqual(killed,[123,456])
        proof.processes={};proof.run=lambda *args,**kwargs: SimpleNamespace(stdout='')
        with self.assertRaises(RuntimeError): proof.cleanup()

    def test_replaced_process_fails_continuity(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'host.pid').write_text('123')
            proof=LiveAgentProof(root,None,None);proof.directory=root;proof.host_pid=123
            proof.processes={123:'old start time and command'}
            proof.process=lambda _: 'new start time and command'
            with self.assertRaises(AssertionError): proof.assert_alive()

if __name__=='__main__': unittest.main()
