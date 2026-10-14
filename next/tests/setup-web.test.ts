import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporary } from './helpers.js';
import { startSetupWeb } from '../node/setup-web.js';

test('browser setup has no workspace question and rejects unauthorized or cross-origin changes',async t=>{
  const {dir}=temporary(t);let calls=0;
  const server=await startSetupWeb({dir:join(dir,'state')},'fixture',async()=>{calls++;return {dir,cli:'fixture',providers:['codex']};});
  t.after(server.close);
  const url=new URL(server.url),origin=url.origin,authorization='Bearer '+url.hash.slice(1);
  const page=await fetch(origin);const html=await page.text();assert.equal(page.status,200);assert.match(html,/Connect Relay/);assert.doesNotMatch(html,/Choose.*workspace|all\/folder/);
  assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  assert.equal((await fetch(origin+'/api/status')).status,403);
  assert.equal((await fetch(origin+'/api/status',{headers:{Authorization:authorization,Origin:'https://attacker.invalid'}})).status,403);
  const headers={Authorization:authorization,Origin:origin,'Content-Type':'application/json'};
  const missing=await fetch(origin+'/api/setup',{method:'POST',headers,body:JSON.stringify({name:'Name',invitation:'',provider:'auto'})});assert.equal(missing.status,400);assert.equal(calls,0);
  const body=JSON.stringify({name:'Name',invitation:'fixture',provider:'auto'});
  assert.equal((await fetch(origin+'/api/setup',{method:'POST',headers,body})).status,200);
  assert.equal((await fetch(origin+'/api/setup',{method:'POST',headers,body})).status,200);assert.equal(calls,1,'Retrying the button must not rejoin or reinstall');
});

test('browser setup reports an actionable failure and allows retry without exposing credentials',async t=>{
  const {dir}=temporary(t);let calls=0;
  const server=await startSetupWeb({dir:join(dir,'state')},'fixture',async()=>{calls++;throw new Error('Invitation expired. Ask your friend for a new one.');});
  t.after(server.close);
  const url=new URL(server.url),headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json'};
  for(let i=0;i<2;i++){
    const response=await fetch(url.origin+'/api/setup',{method:'POST',headers,body:JSON.stringify({name:'Name',invitation:'private-invitation',provider:'auto'})});
    assert.equal(response.status,400);const result=await response.text();assert.match(result,/Invitation expired/);assert.doesNotMatch(result,/private-invitation/);
  }
  assert.equal(calls,2);
});
