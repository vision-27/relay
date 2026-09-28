import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, routeRoom } from '../core/room.js';
import { SQLite } from '../node/sqlite.js';
import { binding, code } from './helpers.js';
async function fixture(t:test.TestContext){
  const db=new SQLite(':memory:');t.after(()=>db.close());const room=new Room(db);
  const owner=await room.create('Project','Alice',code.repository),member=await room.authenticate(owner.token),a=binding(member.id,'codex');room.register(member,a);
  const invitation=await room.invite(member),joined=await room.join(invitation.code,'Bob',code.repository),peer=await room.authenticate(joined.token),b=binding(peer.id,'claude');room.register(peer,b);
  return {db,room,member,peer,a,b,owner,joined};
}
test('durable append deduplicates retries but rejects changed content',async t=>{
  const {room,member,a}=await fixture(t);const event={id:crypto.randomUUID(),sessionId:a.id,kind:'decision' as const,text:'Use cookies',paths:['src/auth']};
  const first=await room.append(member,event),retry=await room.append(member,event);
  assert.equal(first.seq,retry.seq);assert.equal(room.events().length,1);
  await assert.rejects(room.append(member,{...event,text:'Use tokens'}),/different contents/);
});
test('a reply must originate in the addressed session, and receipts cannot regress',async t=>{
  const {room,member,peer,a,b}=await fixture(t);
  const question=await room.append(member,{id:crypto.randomUUID(),sessionId:a.id,kind:'question',text:'What changed?',paths:[],targetSessionId:b.id});
  assert.throws(()=>room.receipt(member,{eventId:question.id,sessionId:b.id,state:'delivered',detail:'',updatedAt:''}),/another member/);
  await assert.rejects(room.append(member,{id:crypto.randomUUID(),sessionId:a.id,kind:'reply',text:'Spoofed',paths:[],replyTo:question.id,targetSessionId:a.id}),/addressed session/);
  await room.append(peer,{id:crypto.randomUUID(),sessionId:b.id,kind:'reply',text:'Cookies',paths:[],replyTo:question.id,targetSessionId:a.id});
  room.receipt(peer,{eventId:question.id,sessionId:b.id,state:'accepted',detail:'Late receipt',updatedAt:''});
  assert.equal(room.receipts().find(r=>r.eventId===question.id)?.state,'answered');
});
test('single-use invitations enforce repository identity, membership and revocation',async t=>{
  const {room,member,peer,joined}=await fixture(t);const invitation=await room.invite(member);
  await assert.rejects(room.join(invitation.code,'Eve','different/repo'),/different Git repository/);
  await room.join(invitation.code,'Third',code.repository);
  await assert.rejects(room.join(invitation.code,'Again',code.repository),/already used/);
  room.revoke(member,peer.id);await assert.rejects(room.authenticate(joined.token),/revoked/);
  assert.equal(room.sessions().find(s=>s.memberId===peer.id)?.state,'closed');
});
test('closed sessions free capacity and cannot bypass the active-session cap when resumed',async t=>{
  const {room,member,a}=await fixture(t),closed={...binding(member.id,'codex'),state:'closed' as const};room.register(member,closed);
  for(let i=0;i<62;i++)room.register(member,binding(member.id,'codex'));
  assert.throws(()=>room.register(member,{...closed,state:'active'}),/active-session limit/);
  assert.throws(()=>room.register(member,binding(member.id,'codex')),/active-session limit/);
  room.register(member,{...a,state:'closed'});room.register(member,{...closed,state:'active'});
  assert.equal(room.sessions().filter(s=>s.state!=='closed').length,64);
});
test('source revision is captured with the event, separately from current session state',async t=>{
  const {room,member,a}=await fixture(t);const captured={...code,head:'b'.repeat(40),dirty:true};
  room.register(member,{...a,git:{...code,head:'c'.repeat(40)}});
  const event=await room.append(member,{id:crypto.randomUUID(),sessionId:a.id,kind:'contract',text:'Login returns user',paths:[],git:captured});
  assert.equal(event.git.head,captured.head);assert.equal(event.git.dirty,true);
});
test('redaction applies to durable text and raw input is stored only as a hash',async t=>{
  const {room,db,member,a}=await fixture(t);const credential='sk-'+ 'private'.repeat(8);
  const event=await room.append(member,{id:crypto.randomUUID(),sessionId:a.id,kind:'observation',text:'Example '+credential,paths:[]});
  assert.match(event.text,/REDACTED/);assert.equal(JSON.stringify(db.all('SELECT * FROM events')).includes(credential),false);
});
test('HTTP rejects oversized bodies and invalid replay cursors',async t=>{
  const {room,owner}=await fixture(t);const headers={Authorization:`Bearer ${owner.token}`};
  const invalid=await routeRoom(room,new Request('http://local/events?after=-1',{headers}),'events');assert.equal(invalid.status,400);
  const large=await routeRoom(room,new Request('http://local/events',{method:'POST',headers,body:'x'.repeat(40_001)}),'events');assert.equal(large.status,413);
});
