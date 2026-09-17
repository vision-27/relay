"""Read-only HTTPS/authentication QA against an explicitly selected Relay hub.

Uses an existing local member token without printing it. Does not create members,
publish context, configure networking, or bypass TLS verification.
"""
import argparse
from datetime import datetime, timezone
from http.client import HTTPSConnection
from http.cookies import SimpleCookie
import json
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--data',default='.relay/hub')
    parser.add_argument('--output')
    args=parser.parse_args()
    directory=Path(args.data)
    origin=json.loads((directory/'network.json').read_text(encoding='utf-8'))['public_origin']
    parsed=urlsplit(origin)
    if parsed.scheme!='https' or parsed.username or parsed.password or parsed.path not in {'','/'} or parsed.query or parsed.fragment:
        raise ValueError('An exact HTTPS origin is required')
    token=(directory/'owner-token').read_text(encoding='utf-8').strip()
    checks=[]

    def probe(label,path,expected,method='GET',data=None,headers=None,stream=False):
        connection=HTTPSConnection(parsed.hostname,parsed.port or 443,timeout=15)
        try:
            headers=dict(headers or {})
            if data is not None:headers['Content-Type']='application/json'
            connection.request(method,path,body=json.dumps(data) if data is not None else None,headers=headers)
            response=connection.getresponse()
            if response.status!=expected:raise RuntimeError(f'{label}: expected {expected}, got {response.status}')
            if stream:
                assert response.getheader('Content-Type')=='text/event-stream'
                assert response.readline().strip()==b'event: changed'
                payload=None
            else:
                raw=response.read()
                payload=json.loads(raw) if response.getheader('Content-Type','').startswith('application/json') else None
            checks.append({'check':label,'result':'passed','http_status':response.status})
            return payload,response.getheader('Set-Cookie')
        finally:connection.close()

    health,_=probe('HTTPS certificate and health','/health',200)
    assert health['ok'] is True
    probe('Browser assets','/',200)
    probe('Anonymous workspace access blocked','/api/state',401)
    probe('Invalid token rejected','/api/state',401,headers={'Authorization':'Bearer invalid-qa-token'})
    probe('Local-owner bootstrap disabled behind proxy','/api/local-session',401,'POST',{}, {'X-Relay-Client':'web'})
    probe('Foreign browser origin rejected','/api/state',403,headers={'Origin':'https://untrusted.example'})
    state,_=probe('Existing member token accepted','/api/state',200,headers={'Authorization':'Bearer '+token})
    _,cookie=probe('Browser token login','/api/login',200,'POST',{'token':token},{'X-Relay-Client':'web','Origin':origin})
    parsed_cookie=SimpleCookie();parsed_cookie.load(cookie)
    morsel=parsed_cookie['relay_token']
    assert morsel['secure'] and morsel['httponly'] and morsel['samesite']=='Strict'
    probe('Secure browser session accepted','/api/state',200,headers={'Cookie':'relay_token='+morsel.value})
    probe('Authenticated live stream','/api/stream',200,headers={'Authorization':'Bearer '+token},stream=True)
    report={'result':'passed','origin':origin,'checked_at':datetime.now(timezone.utc).isoformat(),
            'checks':checks,'projects_visible':len(state['projects']),'second_physical_pc_tested':False}
    if args.output:Path(args.output).write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))


if __name__=='__main__':main()
