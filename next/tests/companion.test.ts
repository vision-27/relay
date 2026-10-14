import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../core/room.js';
import { RemoteMcp } from '../core/remote-mcp.js';
import { Companion, routeCompanion } from '../core/companion.js';
import { SQLite } from '../node/sqlite.js';
import { deliverSession, wakeMessage } from '../node/remote-companion.js';
import { companionConfig } from '../node/remote-companion-install.js';

async function fixture(t:test.TestContext){
  const db=new SQLite(':memory:');t.after(()=>db.close());const room=new Room(db),mcp=new RemoteMcp(room,db),companion=new Companion(room,db);
  const owner=await room.create('Companions','Alice','network:companion','network'),alice=await room.authenticate(owner.token);
  const invitation=await room.invite(alice),joined=await room.join(invitation.code,'Bob','other'),bob=await room.authenticate(joined.token);
  const url=new URL('https://relay.test/projects/fixture/mcp');
  const call=(member:typeof alice,name:string,args:Record<string,unknown>)=>mcp.call(member,name,args,url) as Promise<any>;
  const a=await call(alice,'relay_open',{provider:'codex',task:'Current work',native_session_id:'native-alice'}),b=await call(bob,'relay_open',{provider:'codex',task:'Other work',native_session_id:'native-bob'});
  const ask=async()=>{const id=crypto.randomUUID();await call(bob,'relay_ask',{session_key:b.session_key,target_session_id:a.session_id,request_id:id,question:'A question from Bob'});return id;};
  return {db,room,mcp,companion,owner,alice,bob,a,b,call,ask};
}

test('companion sees only its member native bindings and cannot hand off another member messages',async t=>{
  const {companion,alice,bob,a,ask}=await fixture(t),eventId=await ask();
  const read=companion.call(alice,{operation:'read'}) as any;
  assert.deepEqual(read.sessions,[{sessionId:a.session_id,nativeSessionId:'native-alice',eventIds:[eventId]}]);
  assert.ok(!JSON.stringify(read).includes('session_key'));
  assert.throws(()=>companion.call(bob,{operation:'claim',sessionId:a.session_id,eventId,attemptId:'attempt'}),/belong|own/i);
});

test('competing companions batch once and reconnect cannot enqueue accepted messages again',async t=>{
  const {room,companion,alice,ask}=await fixture(t);await ask();await ask();
  const session=(companion.call(alice,{operation:'read'}) as any).sessions[0];let calls=0;
  const api=async(input:Record<string,unknown>)=>companion.call(alice,input);
  const queue=async(nativeId:string,text:string)=>{calls++;assert.equal(nativeId,'native-alice');assert.match(text,/your own session_key/);assert.ok(!text.includes('A question from Bob'));return true;};
  await Promise.all([deliverSession(session,api,queue),deliverSession(session,api,queue)]);
  // Claims are per message; racing processes may split a batch, but no event is handed off twice.
  assert.ok(calls>=1&&calls<=2);const previous=calls;
  await deliverSession(session,api,queue);assert.equal(calls,previous);
  assert.equal((companion.call(alice,{operation:'read'}) as any).sessions[0].eventIds.length,0);
  assert.ok(room.receipts().every(r=>r.state==='accepted'));
});

test('ambiguous native delivery is not retried and hooks can still recover the question',async t=>{
  const {room,companion,alice,a,call,ask}=await fixture(t),eventId=await ask();let calls=0;
  const session=(companion.call(alice,{operation:'read'}) as any).sessions[0],api=async(input:Record<string,unknown>)=>companion.call(alice,input);
  await deliverSession(session,api,async()=>{calls++;throw Error('Timed out after possible acceptance');});
  await deliverSession(session,api,async()=>{calls++;return true;});assert.equal(calls,1);assert.equal(room.receipts()[0]!.state,'uncertain');
  const inbox=await call(alice,'relay_check',{session_key:a.session_key});assert.equal(inbox.inbox.messages[0].id,eventId);
  await call(alice,'relay_reply',{session_key:a.session_key,question_id:eventId,request_id:crypto.randomUUID(),answer:'Recovered through existing inbox'});
  assert.equal(room.receipts().find(r=>r.eventId===eventId)!.state,'answered');
});

test('already answered messages and closed sessions cannot start another native turn',async t=>{
  const {companion,alice,a,call,ask}=await fixture(t),eventId=await ask();
  await call(alice,'relay_reply',{session_key:a.session_key,question_id:eventId,request_id:crypto.randomUUID(),answer:'Done'});
  assert.deepEqual(companion.call(alice,{operation:'claim',sessionId:a.session_id,eventId,attemptId:'late'}),{claimed:false});
  await call(alice,'relay_close',{session_key:a.session_key});
  assert.deepEqual((companion.call(alice,{operation:'read'}) as any).sessions,[]);
  assert.throws(()=>companion.call(alice,{operation:'claim',sessionId:a.session_id,eventId,attemptId:'late'}),/cannot receive/);
});

test('companion cannot forge read receipts and a late native outcome cannot overwrite an answer',async t=>{
  const {room,companion,alice,a,call,ask}=await fixture(t),eventId=await ask(),base={sessionId:a.session_id,eventId,attemptId:'one'};
  companion.call(alice,{operation:'claim',...base});
  assert.throws(()=>companion.call(alice,{operation:'finish',...base,state:'delivered'}),/cannot claim/);
  await call(alice,'relay_reply',{session_key:a.session_key,question_id:eventId,request_id:crypto.randomUUID(),answer:'Fast answer'});
  companion.call(alice,{operation:'finish',...base,state:'accepted'});
  assert.equal(room.receipts().find(r=>r.eventId===eventId)!.state,'answered');
});

test('HTTP companion endpoint enforces authentication, origin, bounds and input shape',async t=>{
  const {room,companion,owner}=await fixture(t),url='https://relay.test/projects/fixture/companion';
  const request=(body:string,token=owner.token,origin?:string)=>routeCompanion(companion,room,new Request(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body}));
  assert.equal((await request('{"operation":"read"}')).status,200);
  assert.equal((await request('{"operation":"read"}','invalid')).status,401);
  assert.equal((await request('{"operation":"read"}',owner.token,'https://relay.test')).status,403);
  assert.equal((await request('null')).status,400);
  assert.equal((await request('x'.repeat(4001))).status,413);
});

test('companion installation replaces only its MCP entry and preserves unrelated settings',()=>{
  const before='model = "existing"\n[mcp_servers.other]\nurl = "https://other.test"\n[mcp_servers.relay_remote]\nurl = "https://relay.test"\n[mcp_servers.relay_remote.http_headers]\nAuthorization = "private"\n[features]\nkeep = true\n';
  const once=companionConfig(before,'node','/stable/companion.js','/private/connection.json');
  assert.match(once,/model = "existing"/);assert.match(once,/url = "https:\/\/other.test"/);assert.match(once,/\[features\]\nkeep = true/);
  assert.ok(!once.includes('Authorization'));assert.equal(companionConfig(once,'node','/stable/companion.js','/private/connection.json'),once);
});
