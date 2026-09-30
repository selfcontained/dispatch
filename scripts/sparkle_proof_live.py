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
        self.creation_attempted = False
        self.quiesced = False
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
        self.creation_attempted = True
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

    def request_archive(self):
        if not self.creation_attempted: return
        ids = {self.agent_id} if self.agent_id else set()
        try:
            # The create may have committed even if its response was lost.
            for agent in self.api('/agents')['agents']:
                if agent.get('name') == 'Sparkle live proof' and Path(agent.get('cwd','')).resolve() == self.root.resolve():
                    ids.add(agent['id'])
        except Exception: pass
        for agent_id in ids:
            if not agent_id.startswith('agt_') or '/' in agent_id: continue
            try: self.api('/agents/'+agent_id+'?cleanupWorktree=keep','DELETE')
            except Exception: pass
        # A 202 is only a request, never evidence that launch has quiesced.

    def listing(self):
        rows = []
        for line in self.run('ps','-axo','pid=,command=',capture=True).stdout.splitlines():
            fields = line.strip().split(None,1)
            if len(fields)==2: rows.append((int(fields[0]),fields[1]))
        return rows

    def confirm_service_stopped(self):
        # Called only AFTER native service/database cleanup succeeds. Reject a
        # surviving API/worker/coordinator which could still launch a host.
        roots = {str(self.root),str(self.root.resolve())}
        for _, command in self.listing():
            producer = any(root in command for root in roots) and ('--server' in command or '--worker' in command)
            api = str(self.app/'Contents/Helpers/dispatch') in command and 'agent-host' not in command
            if producer or api: raise RuntimeError('Proof launch producer survived service cleanup')
        self.quiesced = True

    def cleanup(self):
        if not self.creation_attempted: return
        if not self.quiesced: raise RuntimeError('Cannot prove live cleanup before launch producers stop')
        roots = {str(self.root),str(self.root.resolve())}
        deadline = time.monotonic()+15
        quiet_since = None
        first_seen = {}
        while time.monotonic() < deadline:
            owned = {}
            # Fresh discovery each time catches a launch missed by the first
            # snapshot, including when no create response/agent ID arrived.
            for pid, command in self.listing():
                if any(('agent-host' in command and root+'/agents/' in command) or root+'/fake-acp.py' in command for root in roots):
                    identity = self.process(pid)
                    if identity: owned[pid] = identity
            for pid, identity in self.processes.items():
                if self.process(pid) == identity: owned[pid] = identity
            now = time.monotonic()
            if not owned:
                if quiet_since is None: quiet_since = now
                if now-quiet_since >= 1: return
            else:
                quiet_since = None
                for pid, identity in owned.items():
                    first_seen.setdefault((pid,identity),now)
                    sig = signal.SIGKILL if now-first_seen[(pid,identity)] >= 10 else signal.SIGTERM
                    if self.process(pid) == identity:
                        try: os.kill(pid,sig)
                        except ProcessLookupError: pass
            time.sleep(.2)
        raise RuntimeError('Owned live agent processes did not stop')
