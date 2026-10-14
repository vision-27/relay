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

test('expired reservations can be reclaimed but cannot be completed by another owner',async t=>{
  const {room,db,member,peer,a,b}=await fixture(t);const lease=room.collaboration.mutateTask(member,{sessionId:a.id,title:'Original',paths:['src'],ttlSeconds:60});
  const expired={...lease,expiresAt:Date.now()-1};db.exec('UPDATE tasks SET data=? WHERE id=?',JSON.stringify(expired),lease.id);
  assert.throws(()=>room.collaboration.mutateTask(peer,{sessionId:b.id,operation:'complete',id:lease.id,version:lease.version}),/another session/);
  const claimed=room.collaboration.mutateTask(peer,{sessionId:b.id,operation:'claim',id:lease.id,version:lease.version});assert.equal(claimed.sessionId,b.id);assert.equal(claimed.version,lease.version+1);
});

test('owner delegates invitations without granting ownership or session impersonation',async t=>{
  const {room,db,member,peer,owner,joined,a}=await fixture(t);
  const request=(token:string,body:unknown)=>routeRoom(room,new Request('http://local/members',{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)}),'members');
  assert.equal((await request(joined.token,{memberId:peer.id,role:'admin'})).status,403);
  assert.equal((await request(owner.token,{memberId:peer.id,role:'owner'})).status,400);
  assert.equal((await request(owner.token,{memberId:member.id,role:'member'})).status,403);
  assert.equal((await request(owner.token,{memberId:crypto.randomUUID(),role:'admin'})).status,404);
  await assert.rejects(room.invite(peer),/owner or an admin/);
  assert.equal((await request(owner.token,{memberId:peer.id,role:'admin'})).status,200);
  const admin=await room.authenticate(joined.token);assert.equal(admin.role,'admin');
  const invitation=await room.invite(admin);
  const third=await room.join(invitation.code,'Windows',code.repository);
  const ordinary=await room.authenticate(third.token);assert.equal(ordinary.role,'member');
  await assert.rejects(room.join(invitation.code,'Reuse',code.repository),/already used/);
  assert.throws(()=>room.own(admin,a.id),/another member/);
  assert.equal((await request(joined.token,{memberId:third.memberId,role:'admin'})).status,403);
  assert.throws(()=>room.revoke(admin,member.id),/Only the owner/);
  assert.throws(()=>room.revoke(admin,admin.id),/Only the owner/);
  room.setMemberRole(member,ordinary.id,'admin');
  assert.throws(()=>room.revoke(admin,ordinary.id),/Only the owner/);
  room.setMemberRole(member,ordinary.id,'member');room.revoke(admin,ordinary.id);
  await assert.rejects(room.authenticate(third.token),/revoked/);
  assert.equal((await request(owner.token,{memberId:ordinary.id,role:'admin'})).status,404);
  room.setMemberRole(member,peer.id,'admin');
  assert.equal(db.all('SELECT * FROM membership_audit').length,3);
  assert.equal((await request(owner.token,{memberId:peer.id,role:'member'})).status,200);
  await assert.rejects(room.invite(await room.authenticate(joined.token)),/owner or an admin/);
  assert.equal(db.all('SELECT * FROM membership_audit').length,4);
});
