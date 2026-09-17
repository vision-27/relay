"""Explicit, bounded real-client smoke test. Uses the installed agent login.

Run: python tests/live_smoke.py --provider codex|claude --live
Creates an isolated test repository and source session; does not read existing conversations.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from relay.adapters import CodexRPC, CodexAdapter, ClaudeAdapter, ANSWER_SCHEMA


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--provider',choices=['codex','claude'],required=True)
    parser.add_argument('--live',action='store_true',required=True)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]/'.relay'/'smoke'/str(uuid.uuid4())
    root.mkdir(parents=True)
    prompt='For this Relay integration test, remember: Atlas cache keys include organisation_id because a global user cache could return data belonging to another organisation. No code changes are requested. Reply with one sentence acknowledging this design decision.'
    config=dict(repo=str(root),response_timeout=120)
    if args.provider=='codex':
        rpc=CodexRPC(str(root))
        try:
            source=rpc.request('thread/start',{'cwd':str(root),'sandbox':'read-only','approvalPolicy':'untrusted',
                'developerInstructions':'Only respond in text. Do not use tools or change files.'})['thread']['id']
            rpc.request('turn/start',{'threadId':source,'input':[{'type':'text','text':prompt}],
                'environments':[],'sandboxPolicy':{'type':'readOnly'}})
            end=time.monotonic()+120
            while time.monotonic()<end:
                message=rpc.backlog.pop(0) if rpc.backlog else rpc.receive(end-time.monotonic())
                if message.get('method')=='turn/completed' and message.get('params',{}).get('threadId')==source:
                    if message['params']['turn']['status']!='completed':raise RuntimeError('Source turn failed')
                    break
            else:raise TimeoutError('Source turn timed out')
            config['source_id']=source
        finally:rpc.close()
        adapter=CodexAdapter(config)
    else:
        result=subprocess.run([shutil.which('claude'),'-p','--tools','','--strict-mcp-config',
            '--mcp-config','{"mcpServers":{}}','--disallowedTools','mcp__*',
            '--settings','{"disableAllHooks":true}','--output-format','json'],
            input=prompt,cwd=root,capture_output=True,text=True,encoding='utf-8',timeout=120)
        if result.returncode:raise RuntimeError('Claude source failed: '+result.stderr[-400:])
        output=json.loads(result.stdout)
        if output.get('is_error'):raise RuntimeError('Claude source returned an error')
        source=output['session_id']
        base=Path(os.environ.get('CLAUDE_CONFIG_DIR',str(Path.home()/'.claude')))/'projects'/re.sub(r'[^a-zA-Z0-9]','-',str(root))
        config.update(source_id=source,source_file=str(base/(source+'.jsonl')))
        adapter=ClaudeAdapter(config)
    try:
        snapshot=adapter.snapshot()
        print(json.dumps({'provider':args.provider,'stage':'source_observed','events':len(snapshot['events']),'completed':bool(snapshot['cursor'])}),flush=True)
        answer=adapter.explain('Why must Atlas cache keys include organisation_id? Answer from this session’s recorded decision.',ANSWER_SCHEMA,snapshot)
        if 'organi' not in answer['data']['answer'].lower():raise RuntimeError('Answer failed to recall the source fact')
        after=adapter.snapshot()
        if after['cursor']!=snapshot['cursor']:raise RuntimeError('Explanation changed the source conversation')
        evidence={'provider':args.provider,'source_id':source,'config':config,'source_unchanged':True,
                  'events':len(snapshot['events']),'answer':answer}
        (root/'verification.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
        print(json.dumps({'provider':args.provider,'result':'passed','source_unchanged':True,'evidence':str(root/'verification.json')}),flush=True)
    finally:adapter.close()


if __name__=='__main__':main()
