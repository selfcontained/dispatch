"""Live ACP assertions and owned-process cleanup for the isolated VM driver."""
import json
import os
from pathlib import Path
import signal
import time
import urllib.request

class LiveAgentProof:
    def __init__(self, root, app, run):
        self.root, self.app, self.run = root, app, run
        self.agent_id = None
        self.processes = {}
        self.engine = None

    def api(self, path, method='GET', body=None):
        request = urllib.request.Request('http://127.0.0.1:56789/api/v1'+path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type':'application/json'})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as response:
            return json.load(response)

    def until(self, check, timeout=30):
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            value = check()
            if value: return value
            time.sleep(.2)
        raise AssertionError('Live agent assertion timed out')

    def process(self, pid):
        return self.run('ps','-p',str(pid),'-o','lstart=','-o','command=',capture=True,check=False).stdout.strip()

    def start(self):
        agent = self.api('/agents','POST',{'name':'Sparkle live proof','type':'claude','cwd':str(self.root),'useWorktree':False})['agent']
        self.agent_id = agent['id']
        assert self.agent_id.startswith('agt_') and '/' not in self.agent_id
        self.until(lambda: self.api('/agents/'+self.agent_id)['agent']['status']=='running')
        self.directory = self.root/'agents'/self.agent_id
        self.host_pid = int((self.directory/'host.pid').read_text())
        host = self.process(self.host_pid)
        assert 'agent-host' in host and str(self.directory) in host, 'Host PID is not this proof agent'
        self.processes[self.host_pid] = host
        self.api('/streams/'+self.agent_id+'/blocks','POST',{'text':'sparkle-hold'})
        self.until(lambda: (self.root/'live-turn-started.json').exists())
        self.engine = json.loads((self.root/'live-turn-started.json').read_text())
        engine = self.process(self.engine['pid'])
        assert str(self.root/'fake-acp.py') in engine, 'Engine PID is not the proof fixture'
        self.processes[self.engine['pid']] = engine
        self.assert_alive()
        return {'agentID':self.agent_id,'hostPID':self.host_pid,'enginePID':self.engine['pid'],'sessionID':self.engine['sessionID']}

    def assert_alive(self):
        assert int((self.directory/'host.pid').read_text()) == self.host_pid, 'Host was replaced'
        for pid, identity in self.processes.items():
            assert self.process(pid) == identity, 'Owned host/engine exited or was replaced'

    def settled(self, text):
        entries = self.api('/streams/'+self.agent_id+'/blocks')['entries']
        for entry in entries:
            turn = (entry.get('block') or {}).get('turn') or {}
            if turn.get('settled') is True and not turn.get('error') and text in (turn.get('result') or {}).get('text',''):
                return True
        return False

    def finish(self):
        self.assert_alive()
        assert self.api('/agents/'+self.agent_id)['agent']['cliSessionId'] == self.engine['sessionID'], 'Engine session changed'
        assert not self.settled('sparkle-held-turn-completed'), 'Turn settled before release'
        (self.root/'release-live-turn').touch()
        self.until(lambda: self.settled('sparkle-held-turn-completed'))
        self.api('/streams/'+self.agent_id+'/blocks','POST',{'text':'sparkle-followup'})
        self.until(lambda: self.settled('sparkle-followup-completed'))
        self.assert_alive()
        return {'inFlightTurnCompleted':True,'followupCompleted':True,'sameHostAndEngine':True}

    def cleanup(self):
        if not self.agent_id: return
        # Also discover a host/engine created just before start() failed.
        directory = self.root/'agents'/self.agent_id
        listing = self.run('ps','-axo','pid=,command=',capture=True).stdout
        for line in listing.splitlines():
            fields = line.strip().split(None,1)
            if len(fields)!=2: continue
            pid, command = fields
            if ('agent-host' in command and str(directory) in command) or str(self.root/'fake-acp.py') in command:
                identity = self.process(int(pid))
                if identity: self.processes.setdefault(int(pid),identity)
        try: self.api('/agents/'+self.agent_id+'?cleanupWorktree=keep','DELETE')
        except Exception:
            # With no captured identity, we cannot prove a pending launch stopped.
            if not self.processes: raise RuntimeError('Could not archive or identify the proof agent')
            # Server may be down; verified PID fallback below.
        for pid, identity in self.processes.items():
            if self.process(pid) == identity:
                try: os.kill(pid,signal.SIGTERM)
                except ProcessLookupError: pass
        deadline = time.monotonic()+10
        while time.monotonic() < deadline:
            if all(self.process(pid) != identity for pid, identity in self.processes.items()): return
            time.sleep(.2)
        for pid, identity in self.processes.items():
            if self.process(pid) == identity:
                try: os.kill(pid,signal.SIGKILL)
                except ProcessLookupError: pass
        self.until(lambda: all(self.process(pid) != identity for pid, identity in self.processes.items()),timeout=5)
