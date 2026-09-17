"""Check real session discovery and guided setup using only isolated QA sources.

No model calls, no source changes, and no agent-client settings are installed.
"""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from relay import onboarding
from relay.client import Client, discover_sessions
from relay.server import Hub
from relay.store import Store


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--codex-evidence',required=True)
    parser.add_argument('--claude-evidence',required=True)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    sources={provider:json.loads(Path(path).read_text(encoding='utf-8'))['config'] for provider,path in
             [('codex',args.codex_evidence),('claude',args.claude_evidence)]}
    for source in sources.values():
        if not Path(source['repo']).resolve().is_relative_to(root/'.relay/smoke'):
            raise ValueError('Only isolated smoke sources may be used')
    qa=root/'.relay/setup-qa'/str(uuid.uuid4())
    store=Store(qa/'hub');hub=Hub(('127.0.0.1',0),store)
    thread=threading.Thread(target=hub.serve_forever,daemon=True);thread.start()
    url=f'http://127.0.0.1:{hub.server_address[1]}'
    client=Client(url,(qa/'hub/owner-token').read_text())
    project=client.action('project',{'name':'Guided setup QA'})['id']
    previous=Path.cwd()
    results=[]
    try:
        os.chdir(qa)
        for provider,source in sources.items():
            matches=discover_sessions(provider,source['repo'])
            selected=next((i+1 for i,s in enumerate(matches) if s['id']==source['source_id']),None)
            if not selected:raise RuntimeError(f'{provider}: isolated source missing from session picker')
            answers=['y']+['1' if provider=='codex' else '2',str(selected),'QA selected conversation','y']
            with patch('builtins.input',side_effect=answers), patch('relay.companion.data_directory',return_value=qa/provider/'private/companion'), contextlib.redirect_stdout(io.StringIO()):
                path=onboarding.start(SimpleNamespace(url=url,project=project,token_file=str(qa/'hub/owner-token'),setup_only=True,repo=source['repo']))
            config=json.loads(path.read_text())
            assert config['source_id']==source['source_id']
            results.append({'provider':provider,'discovery':'passed','guided_connection':'passed'})
        report={'result':'passed','checks':results,'observations_uploaded':len(client.request('/api/state')['observations'])}
        (qa/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps(dict(report,evidence=str(qa/'verification.json'))))
    finally:
        os.chdir(previous);hub.shutdown();hub.server_close();thread.join()


if __name__=='__main__':main()
