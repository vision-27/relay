import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../core/room.js';
import { Dashboard, routeDashboard } from '../core/dashboard.js';
import { dashboardPage } from '../core/dashboard-page.js';
import { RemoteMcp } from '../core/remote-mcp.js';
import { SQLite } from '../node/sqlite.js';

async function fixture(t:test.TestContext){
  const db=new SQLite(':memory:');t.after(()=>db.close());const room=new Room(db),dashboard=new Dashboard(room,db),mcp=new RemoteMcp(room,db);
  const a=await room.create('Shared room','Alice','network:fixture','network'),alice=await room.authenticate(a.token),invitation=await room.invite(alice),b=await room.join(invitation.code,'Bob','other'),bob=await room.authenticate(b.token),url=new URL('https://relay.test/projects/fixture/dashboard');
  const agent=await mcp.call(bob,'relay_open',{provider:'claude',task:'Fix cursor pagination',workspace:'other/repo'},url) as any;
  return {db,room,dashboard,mcp,a,alice,b,bob,url,agent};
}
test('room questions use human identity and roundtrip through an actual MCP conversation',async t=>{
  const {room,dashboard,mcp,alice,bob,url,agent}=await fixture(t),requestId=crypto.randomUUID();
  const input={operation:'send',targetSessionId:agent.session_id,requestId,text:'What is the cursor contract?',sessionId:agent.session_id};
  const sent=await dashboard.call(alice,input,url) as any;assert.equal(sent.event.sessionId,'human_'+alice.id);assert.equal(room.session(sent.event.sessionId).provider,'human');
  await dashboard.call(alice,input,url);assert.equal(room.events().length,1);
  await assert.rejects(dashboard.call(alice,{...input,text:'Changed retry'},url),/different contents/);
  await dashboard.call(alice,{operation:'read'},url);assert.equal(room.receipts()[0]?.state,'queued','Viewing another agent inbox is not its acknowledgement');
  const inbox=await mcp.call(bob,'relay_check',{session_key:agent.session_key},url) as any;assert.equal(inbox.inbox.messages[0].id,requestId);
  await mcp.call(bob,'relay_reply',{session_key:agent.session_key,question_id:requestId,request_id:crypto.randomUUID(),answer:'Follow next_cursor; null means done.'},url);
  const page=await dashboard.call(alice,{operation:'read'},url) as any;assert.equal(page.events.length,2);assert.equal(page.receipts.find((r:any)=>r.eventId===requestId).state,'answered');assert.equal(page.receipts.find((r:any)=>r.eventId===page.events[1].id).state,'queued');
  const ack=await dashboard.call(alice,{operation:'ack',eventId:page.events[1].id},url) as any;assert.equal(ack.state,'delivered');
  await assert.rejects(dashboard.call(alice,{operation:'ack',eventId:requestId},url),/another recipient/);
  const question=await mcp.call(bob,'relay_ask',{session_key:agent.session_key,target_session_id:'human_'+alice.id,request_id:crypto.randomUUID(),question:'Should I include an example?'},url) as any;
  await dashboard.call(alice,{operation:'send',targetSessionId:agent.session_id,requestId:crypto.randomUUID(),replyTo:question.result.event_id,text:'Yes, include an example.'},url);
  assert.equal(room.event(room.events().at(-1)!.id).kind,'reply');
});
test('room readers get bounded chronological history and exact receipts on old pages',async t=>{
  const {dashboard,mcp,alice,bob,url,agent}=await fixture(t);
  for(let i=0;i<55;i++)await dashboard.call(alice,{operation:'send',targetSessionId:agent.session_id,requestId:'q'+i,text:'Message '+i},url);
  const recent=await dashboard.call(alice,{operation:'read'},url) as any;assert.equal(recent.events.length,50);assert.equal(recent.events[0].id,'q5');assert.equal(recent.more,true);
  const older=await dashboard.call(alice,{operation:'read',before:recent.oldest},url) as any;assert.equal(older.events.length,5);assert.equal(older.more,false);
  await mcp.call(bob,'relay_reply',{session_key:agent.session_key,question_id:'q0',request_id:'reply0',answer:'An answer to an old question'},url);
  const next=await dashboard.call(alice,{operation:'read',after:recent.cursor},url) as any;assert.equal(next.events[0].id,'reply0');assert.equal(next.receipts.find((r:any)=>r.eventId==='q0').state,'answered');
  await assert.rejects(dashboard.call(alice,{operation:'read',after:-1},url),/cursor/);
  await assert.rejects(dashboard.call(alice,{operation:'read',after:0,before:5},url),/one history cursor/);
});
test('live connection tickets are hashed, short-lived, single-use and revoked with membership',async t=>{
  const {dashboard,db,room,alice,bob}=await fixture(t);
  const ticket=await dashboard.ticket(bob);assert.ok(!JSON.stringify(db.all('SELECT * FROM browser_tickets')).includes(ticket.ticket));assert.equal(await dashboard.consumeTicket(ticket.ticket),bob.id);await assert.rejects(dashboard.consumeTicket(ticket.ticket),/expired/);
  const expired=await dashboard.ticket(bob);db.exec('UPDATE browser_tickets SET expires=0');await assert.rejects(dashboard.consumeTicket(expired.ticket),/expired/);
  const revoked=await dashboard.ticket(bob);room.revoke(alice,bob.id);await assert.rejects(dashboard.consumeTicket(revoked.ticket),/expired/);
});
test('dashboard enforces membership, same origin, bounded inputs and invite roles',async t=>{
  const {dashboard,room,a,b,alice,bob,url,agent}=await fixture(t);
  const request=(token:string,body:unknown,origin=url.origin)=>routeDashboard(dashboard,room,new Request(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)}));
  assert.equal((await request('',{operation:'read'})).status,401);assert.equal((await request(a.token,{operation:'read'},'https://evil.test')).status,403);
  assert.equal((await request(b.token,{operation:'invite'})).status,403);assert.equal((await request(a.token,{operation:'read',pad:'x'.repeat(40_001)})).status,413);
  const invite=await dashboard.call(alice,{operation:'invite'},url) as any;assert.equal(new URL(invite.url).pathname,'/connect');
  room.register(bob,{...room.session(agent.session_id),state:'closed'});
  await assert.rejects(dashboard.call(alice,{operation:'send',targetSessionId:agent.session_id,requestId:crypto.randomUUID(),text:'Hello'},url),/open agent/);
  const otherDb=new SQLite(':memory:');t.after(()=>otherDb.close());const otherRoom=new Room(otherDb),other=new Dashboard(otherRoom,otherDb);await otherRoom.create('Other','Other','network:other','network');
  assert.equal((await routeDashboard(other,otherRoom,new Request(url,{method:'POST',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},body:'{"operation":"read"}'}))).status,401);
});
test('dashboard serves isolated script with valid JavaScript and no external resources',async()=>{
  const response=dashboardPage(),html=await response.text();assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(response.headers.get('Content-Security-Policy')!,/frame-ancestors 'none'/);
  const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]!;assert.doesNotThrow(()=>new Function(script));assert.ok(!html.includes('src="https://'));assert.match(script,/textContent/);
});
