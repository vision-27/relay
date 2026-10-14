import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../core/room.js';
import { RemoteMcp } from '../core/remote-mcp.js';
import { codexRemoteHooks, mergeCodexRemoteHooks } from '../core/remote-hooks.js';
import { SQLite } from '../node/sqlite.js';

async function fixture(t:test.TestContext){
  const db=new SQLite(':memory:');t.after(()=>db.close());const room=new Room(db),mcp=new RemoteMcp(room,db);
  const owner=await room.create('Hook test','Alice','network:test','network'),alice=await room.authenticate(owner.token);
  const invitation=await room.invite(alice),joined=await room.join(invitation.code,'Bob','other'),bob=await room.authenticate(joined.token);
  const url=new URL('https://relay.test/projects/test/mcp');
  const call=(member:typeof alice,name:string,args:Record<string,unknown>)=>mcp.call(member,name,args,url) as Promise<any>;
  const a=await call(alice,'relay_open',{provider:'codex',task:'Existing work',workspace:'repo-A'}),b=await call(bob,'relay_open',{provider:'claude',task:'Other work'});
  return {db,room,alice,bob,a,b,call};
}
test('native attachment preserves an existing inbox and hooks offer messages without false read receipts',async t=>{
  const {room,alice,bob,a,b,call}=await fixture(t),question=crypto.randomUUID();
  await call(bob,'relay_ask',{session_key:b.session_key,target_session_id:a.session_id,request_id:question,question:'Explain your recent work'});
  const unbound=await call(alice,'relay_hook',{native_session_id:'native-A',hook_event_name:'UserPromptSubmit'});
  assert.match(unbound.hookSpecificOutput.additionalContext,/relay_check/);assert.equal(room.receipts()[0]!.state,'queued');
  await call(alice,'relay_check',{session_key:a.session_key,native_session_id:'native-A'});
  const offered=await call(alice,'relay_hook',{native_session_id:'native-A',hook_event_name:'UserPromptSubmit'});
  assert.match(offered.hookSpecificOutput.additionalContext,/Explain your recent work/);assert.equal(room.receipts()[0]!.state,'accepted');
  assert.deepEqual(await call(bob,'relay_hook',{native_session_id:'native-A',hook_event_name:'Stop',stop_hook_active:false}),{});
  await call(alice,'relay_reply',{session_key:a.session_key,question_id:question,request_id:crypto.randomUUID(),answer:'Here is the answer'});
  assert.equal(room.receipts().find(r=>r.eventId===question)!.state,'answered');
  assert.deepEqual(await call(alice,'relay_hook',{native_session_id:'native-A',hook_event_name:'Stop',stop_hook_active:false}),{});
});
test('new pending questions get one stop continuation, retries are quiet and closed sessions stay closed',async t=>{
  const {room,alice,bob,a,b,call}=await fixture(t);
  await call(alice,'relay_check',{session_key:a.session_key,native_session_id:'native-A'});
  const question=crypto.randomUUID();await call(bob,'relay_ask',{session_key:b.session_key,target_session_id:a.session_id,request_id:question,question:'Arrived during your turn'});
  const stopped=await call(alice,'relay_hook',{native_session_id:'native-A',hook_event_name:'Stop',stop_hook_active:false});assert.equal(stopped.decision,'block');assert.match(stopped.reason,/Arrived during/);
  assert.deepEqual(await call(alice,'relay_hook',{native_session_id:'native-A',hook_event_name:'Stop',stop_hook_active:true}),{});
  assert.deepEqual(await call(alice,'relay_hook',{native_session_id:'native-A',hook_event_name:'Stop',stop_hook_active:false}),{});
  await call(alice,'relay_close',{session_key:a.session_key});
  assert.deepEqual(await call(alice,'relay_hook',{native_session_id:'native-A',hook_event_name:'UserPromptSubmit'}),{});
  assert.equal(room.session(a.session_id).state,'closed');
});
test('hook key recovery preserves session identity and workspace while rejecting conflicting attachment',async t=>{
  const {db,room,alice,a,call}=await fixture(t);
  await call(alice,'relay_check',{session_key:a.session_key,native_session_id:'native-A'});
  const other=await call(alice,'relay_open',{provider:'codex',task:'Different conversation'});
  await assert.rejects(call(alice,'relay_check',{session_key:other.session_key,native_session_id:'native-A'}),/already attached/);
  await assert.rejects(call(alice,'relay_check',{session_key:a.session_key,native_session_id:'native-B'}),/another native/);
  const recovered=await call(alice,'relay_open',{provider:'codex',task:'Resumed work',native_session_id:'native-A'});
  assert.equal(recovered.session_id,a.session_id);assert.equal(room.session(a.session_id).git.repository,'repo-A');assert.notEqual(recovered.session_key,a.session_key);
  await assert.rejects(call(alice,'relay_check',{session_key:a.session_key}),/Invalid conversation/);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM mcp_sessions')).includes(recovered.session_key));
});
test('hook configuration is portable, sends only routing metadata, and preserves unrelated hooks',()=>{
  const generated=codexRemoteHooks();assert.deepEqual(Object.keys(generated.hooks),['UserPromptSubmit','Stop']);
  const serialized=JSON.stringify(generated);assert.ok(!/command|transcript|tool_input|tool_response|\$\{prompt\}/.test(serialized));
  const original={hooks:{Stop:[{hooks:[{type:'command',command:'existing-check'}]}]}},copy=structuredClone(original);
  const once=mergeCodexRemoteHooks(original),twice=mergeCodexRemoteHooks(once);
  assert.deepEqual(original,copy);assert.deepEqual(once,twice);assert.equal(once.hooks.Stop[0].hooks[0].command,'existing-check');
});

test('concurrent native opens cannot create duplicate discoverable sessions',async t=>{
  const {room,alice,call}=await fixture(t);
  const opened=await Promise.all([1,2].map(()=>call(alice,'relay_open',{provider:'codex',task:'One conversation',native_session_id:'same-native'})));
  assert.equal(opened[0].session_id,opened[1].session_id);
  assert.equal(room.sessions().filter(s=>s.task==='One conversation').length,1);
});
