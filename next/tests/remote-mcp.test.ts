import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../core/room.js';
import { RemoteMcp, routeRemoteMcp } from '../core/remote-mcp.js';
import { remoteConnectPage } from '../core/remote-connect.js';
import { SQLite } from '../node/sqlite.js';

async function fixture(t:test.TestContext) {
  const db=new SQLite(':memory:');t.after(()=>db.close());const room=new Room(db),mcp=new RemoteMcp(room,db);
  const alice=await room.create('Friends','Alice','network:friends','network'),owner=await room.authenticate(alice.token);
  const invite=await room.invite(owner),bob=await room.join(invite.code,'Bob','unrelated-workspace');
  const request=(token:string,body:unknown,headers:Record<string,string>={},method='POST')=>routeRemoteMcp(mcp,room,new Request('https://relay.test/projects/friends/mcp',{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}));
  const raw=async(token:string,name:string,args:Record<string,unknown>)=>(await request(token,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})).json() as Promise<any>;
  const call=async(token:string,name:string,args:Record<string,unknown>)=>{const response=await raw(token,name,args);assert.ok(!response.result?.isError,JSON.stringify(response));return JSON.parse(response.result.content[0].text);};
  const a=await call(alice.token,'relay_open',{provider:'codex',task:'Build pagination',workspace:'app-a'});
  const b=await call(bob.token,'relay_open',{provider:'claude',task:'Cursor pagination',workspace:'app-b'});
  return {db,room,mcp,alice,bob,owner,a,b,request,raw,call};
}
test('remote MCP supports cross-workspace discovery, durable question/reply and exact retry receipts',async t=>{
  const {room,alice,bob,a,b,call,raw}=await fixture(t);
  const found=await call(alice.token,'relay_discover',{session_key:a.session_key,person:'Bob',topic:'pagination'});
  assert.equal(found.result.sessions[0].id,b.session_id);assert.equal(found.result.sessions[0].workspace,'app-b');
  const args={session_key:a.session_key,target_session_id:b.session_id,request_id:crypto.randomUUID(),question:'How do you paginate?'};
  const sent=await call(alice.token,'relay_ask',args);assert.equal(sent.result.receipt.state,'queued');
  assert.equal((await raw(bob.token,'relay_ack',{session_key:b.session_key,event_id:args.request_id})).result.isError,true);
  await call(alice.token,'relay_ask',args);assert.equal(room.events().length,1);
  const inbox=await call(bob.token,'relay_check',{session_key:b.session_key});assert.equal(inbox.inbox.messages[0].text,args.question);
  assert.equal(room.receipts()[0]?.state,'accepted');
  const repeated=await call(bob.token,'relay_discover',{session_key:b.session_key});assert.equal(repeated.inbox.messages.length,1);
  await call(bob.token,'relay_ack',{session_key:b.session_key,event_id:args.request_id});assert.equal(room.receipts()[0]?.state,'delivered');
  const reply={session_key:b.session_key,question_id:args.request_id,request_id:crypto.randomUUID(),answer:'Follow the returned cursor.'};
  await call(bob.token,'relay_reply',reply);await call(bob.token,'relay_reply',reply);assert.equal(room.events().length,2);
  const answer=await call(alice.token,'relay_check',{session_key:a.session_key});assert.equal(answer.inbox.messages[0].text,reply.answer);
  const status=await call(alice.token,'relay_status',{session_key:a.session_key,event_id:args.request_id});assert.equal(status.result.receipts[0].state,'answered');
});
test('conversation keys isolate sessions under one account, remain hashed and survive handler restart',async t=>{
  const {db,room,alice,bob,owner,a,b,call,raw}=await fixture(t);
  const other=await call(alice.token,'relay_open',{provider:'codex',task:'Another conversation'});
  const q=crypto.randomUUID();await call(bob.token,'relay_ask',{session_key:b.session_key,target_session_id:a.session_id,request_id:q,question:'Hello'});
  const denied=await raw(alice.token,'relay_reply',{session_key:other.session_key,question_id:q,request_id:crypto.randomUUID(),answer:'Impersonated'});assert.equal(denied.result.isError,true);
  assert.equal((await raw(bob.token,'relay_check',{session_key:a.session_key})).result.isError,true);
  assert.equal((await raw(alice.token,'relay_status',{session_key:other.session_key,event_id:q})).result.isError,true);
  assert.equal((await raw(alice.token,'relay_check',{session_key:'guessed'})).result.isError,true);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM mcp_sessions')).includes(a.session_key));
  const restarted=new RemoteMcp(room,db);const check=await restarted.call(owner,'relay_check',{session_key:a.session_key},new URL('https://relay.test/projects/friends/mcp')) as any;assert.equal(check.inbox.messages[0].id,q);
  await call(alice.token,'relay_reply',{session_key:a.session_key,question_id:q,request_id:crypto.randomUUID(),answer:'Accidental key: '+a.session_key});assert.ok(!JSON.stringify(room.events()).includes(a.session_key));
  await call(alice.token,'relay_close',{session_key:a.session_key});assert.equal((await raw(alice.token,'relay_check',{session_key:a.session_key})).result.isError,true);
  room.revoke(owner,bob.memberId);assert.equal((await routeRemoteMcp(restarted,room,new Request('https://relay.test/mcp',{headers:{Authorization:'Bearer '+bob.token}}))).status,401);
});
test('inbox pagination ignores unrelated history and never silently consumes messages',async t=>{
  const {room,alice,bob,a,b,call}=await fixture(t);
  for(let i=0;i<23;i++)await call(alice.token,'relay_ask',{session_key:a.session_key,target_session_id:b.session_id,request_id:'q'+i,question:'Question '+i});
  const first=await call(bob.token,'relay_check',{session_key:b.session_key,after:0});assert.equal(first.inbox.messages.length,20);assert.equal(first.inbox.has_more,true);
  const second=await call(bob.token,'relay_check',{session_key:b.session_key,after:first.inbox.next_cursor});assert.equal(second.inbox.messages.length,3);assert.equal(second.inbox.has_more,false);
  assert.equal((await call(bob.token,'relay_check',{session_key:b.session_key})).inbox.messages[0].id,'q0');
  const old=room.session(b.session_id);room.register(await room.authenticate(bob.token),{...old,updatedAt:new Date(Date.now()-100_000).toISOString()});
  assert.equal((await call(alice.token,'relay_discover',{session_key:a.session_key,active_only:true})).result.total,0);
  assert.equal((await call(alice.token,'relay_discover',{session_key:a.session_key,active_only:false})).result.sessions[0].recent_activity,false);
});
test('HTTP MCP enforces auth, origin, size, protocol and JSON-RPC boundaries',async t=>{
  const {alice,a,request,raw}=await fixture(t),ping={jsonrpc:'2.0',id:4,method:'ping'};
  assert.equal((await request('',ping)).status,401);
  assert.equal((await request(alice.token,ping,{Origin:'https://evil.test'})).status,403);
  assert.equal((await request(alice.token,null,{},'GET')).status,405);
  assert.equal((await request(alice.token,ping,{'MCP-Protocol-Version':'bad'})).status,400);
  assert.equal((await request(alice.token,ping,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await request(alice.token,ping,{Accept:'application/json'})).status,406);
  assert.equal((await request(alice.token,'x'.repeat(40_001))).status,413);
  assert.equal((await request(alice.token,'{')).status,400);
  assert.equal((await request(alice.token,[ping])).status,400);
  assert.equal((await request(alice.token,{jsonrpc:'2.0',method:'notifications/initialized'})).status,202);
  const init=await (await request(alice.token,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'future',clientInfo:{name:'test',version:'1'},capabilities:{}}})).json() as any;
  assert.equal(init.result.protocolVersion,'2025-11-25');assert.match(init.result.instructions,/next Relay tool call/);
  const listed=await (await request(alice.token,{jsonrpc:'2.0',id:2,method:'tools/list'})).json() as any;assert.equal(listed.result.tools.length,10);
  const invalid=await raw(alice.token,'relay_check',{session_key:a.session_key,after:-1});assert.equal(invalid.result.isError,true);
  assert.equal((await raw(alice.token,'relay_check',{session_key:a.session_key,session_id:'spoof'})).result.isError,true);
});
test('MCP invitation uses a browser fragment and members cannot issue invitations',async t=>{
  const {alice,bob,a,b,call,raw,room}=await fixture(t);
  const invitation=await call(alice.token,'relay_invite',{session_key:a.session_key});const link=new URL(invitation.result.join_url);
  assert.equal(link.pathname,'/connect');assert.equal(link.search,'');const details=JSON.parse(decodeURIComponent(link.hash.slice(1)));assert.equal(details.projectId,'friends');
  await room.join(details.code,'Third','anything');await assert.rejects(room.join(details.code,'Again','anything'),/already used/);
  assert.equal((await raw(bob.token,'relay_invite',{session_key:b.session_key})).result.isError,true);
  const page=remoteConnectPage();assert.match(page.headers.get('Content-Security-Policy')!,/frame-ancestors 'none'/);assert.equal(page.headers.get('Referrer-Policy'),'no-referrer');
});
