"""Tiny ACP engine for the isolated Mac update proof; no model or workspace IO."""
import json
import os
from pathlib import Path
import sys
import threading
import time
import uuid

root = Path(os.path.abspath(__file__)).parent
assert root.parent.resolve() == Path('/tmp').resolve() and root.name.startswith('dispatch-macos-test-sparkle-service-')
lock = threading.Lock()
session = 'sparkle-live-' + uuid.uuid4().hex

def send(value):
    with lock:
        print(json.dumps({'jsonrpc':'2.0', **value}), flush=True)

def turn(request):
    params = request['params']
    text = ''.join(b.get('text','') for b in params['prompt'] if b.get('type') == 'text')
    if 'sparkle-hold' in text:
        marker = root/'live-turn-started.tmp'
        marker.write_text(json.dumps({'pid':os.getpid(),'sessionID':session}))
        marker.replace(root/'live-turn-started.json')
        deadline = time.monotonic()+180
        while not (root/'release-live-turn').exists():
            if time.monotonic() >= deadline:
                send({'id':request['id'],'error':{'code':-32603,'message':'Proof turn timed out'}})
                return
            time.sleep(.1)
        result = 'sparkle-held-turn-completed'
    else:
        result = 'sparkle-followup-completed'
    send({'method':'session/update','params':{'sessionId':params['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':result}}}})
    send({'id':request['id'],'result':{'stopReason':'end_turn'}})

for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'session/prompt':
        threading.Thread(target=turn,args=(request,),daemon=True).start()
        continue
    if 'id' not in request: continue
    if method == 'initialize':
        result = {'protocolVersion':1,'agentInfo':{'name':'sparkle-proof','version':'1'},'agentCapabilities':{'sessionCapabilities':{'resume':{}}},'authMethods':[]}
    elif method == 'session/new': result = {'sessionId':session}
    elif method in ['session/resume','session/set_mode','session/set_config_option','authenticate']: result = {}
    else:
        send({'id':request['id'],'error':{'code':-32601,'message':'Unsupported proof method'}})
        continue
    send({'id':request['id'],'result':result})
