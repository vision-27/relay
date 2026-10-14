import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { temporary } from './helpers.js';
import { SQLite } from '../node/sqlite.js';
import { Room } from '../core/room.js';
import { RemoteMcp, routeRemoteMcp } from '../core/remote-mcp.js';
import { ClaudeSessions } from '../node/claude-session.js';
import { ClaudeSessionMcp } from '../node/claude-session-mcp.js';
import { claudeSessionHook } from '../node/claude-session-hook.js';
import { ClientBudget } from '../node/request-budget.js';

async function fixture(t:test.TestContext){
  const {dir}=temporary(t),db=new SQLite(':memory:');t.after(()=>db.close());
  const room=new Room(db),mcp=new RemoteMcp(room,db),owner=await room.create('Friends','Alice','network:friends','network');
  const connection={server:'http://127.0.0.1:1',projectId:'friends',token:owner.token};
  const request:typeof fetch=async(input,init)=>routeRemoteMcp(mcp,room,new Request(String(input),init));
  const store=new ClaudeSessions(connection,join(dir,'connection.json'),new ClientBudget(join(dir,'budget.sqlite')),request);
  return {dir,room,store};
}
test('Claude automatically binds by native conversation, deduplicates concurrent attachment, and resumes across folders',async t=>{
  const {room,store}=await fixture(t);
  const [a,b]=await Promise.all([store.ensure('native-a'),store.ensure('native-a')]);assert.equal(a.session_id,b.session_id);assert.equal(a.session_key,b.session_key);assert.equal(room.sessions().length,1);
  const peer=await store.ensure('native-b');assert.notEqual(peer.session_id,a.session_id);
  const changedFolder={session_id:'native-a',hook_event_name:'UserPromptSubmit',prompt_id:'prompt-a',cwd:'/unrelated/folder',prompt:'SECRET USER PROMPT',transcript_path:'/private/transcript'};
  const hook=await claudeSessionHook(store,changedFolder,process.pid);assert.match(hook.text!,/session_key/);assert.equal(store.read('native-a')!.session_id,a.session_id);
  assert.doesNotMatch(readFileSync(store.path('native-a'),'utf8'),/SECRET USER PROMPT|unrelated|private\/transcript/);
  const proxy=new ClaudeSessionMcp(store,process.pid,'native-a');
  const call=(name:string,args:any)=>proxy.handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
  await assert.rejects(call('relay_check',{session_key:peer.session_key}),/own Relay key/);
  const opened=await call('relay_open',{provider:'claude',task:'Work anywhere'});assert.equal(JSON.parse(opened.result.content[0].text).session_id,a.session_id);assert.equal(room.sessions().length,2);
  // /clear changes the native identity while the MCP process stays alive.
  await claudeSessionHook(store,{session_id:'native-b',hook_event_name:'UserPromptSubmit',prompt_id:'prompt-b'},process.pid);
  await assert.rejects(call('relay_check',{session_key:a.session_key}),/own Relay key/);
  assert.ok(!(await call('relay_check',{session_key:peer.session_key})).result.isError);
  await call('relay_close',{session_key:peer.session_key});assert.equal(store.read('native-b')?.closed,true);
  await claudeSessionHook(store,{session_id:'native-b',hook_event_name:'UserPromptSubmit'},process.pid);assert.equal(store.read('native-b')?.closed,true);
});
test('server recovery keeps Claude inbox identity and cannot collide with a Codex native ID',async t=>{
  const {store}=await fixture(t);
  const call=async(provider:string)=>JSON.parse((await store.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'relay_open',arguments:{provider,task:'Test',native_session_id:'same-native-id'}}})).result.content[0].text);
  const codex=await call('codex'),claude=await call('claude'),recovered=await call('claude');
  assert.notEqual(codex.session_id,claude.session_id);assert.equal(claude.session_id,recovered.session_id);
});
test('Claude reattachment reports backend rejection instead of returning a false successful session',async t=>{
  const {store}=await fixture(t),state=await store.ensure('native-rejected');
  const proxy=new ClaudeSessionMcp(store,process.pid,'native-rejected');
  const response=await proxy.handle({jsonrpc:'2.0',id:42,method:'tools/call',params:{name:'relay_open',arguments:{provider:'claude',task:'x'.repeat(1001)}}});
  assert.equal(response.result.isError,true);
  assert.equal(response.id,42);
  assert.ok(!JSON.stringify(response).includes(state.session_key),'A rejected request must not advertise attachment success');
});
test('Claude reattachment preserves pending messages returned by its backend check',async t=>{
  const {store,room}=await fixture(t),recipient=await store.ensure('recipient'),sender=await store.ensure('sender');
  const member=await room.authenticate(store.connection.token),id=crypto.randomUUID();
  await room.append(member,{id,sessionId:sender.session_id,targetSessionId:recipient.session_id,kind:'question',text:'Keep this pending question visible',paths:[]});
  const proxy=new ClaudeSessionMcp(store,process.pid,'recipient');
  const response=await proxy.handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'relay_open',arguments:{provider:'claude',task:'Resume'}}});
  const data=JSON.parse(response.result.content[0].text);
  assert.equal(data.session_id,recipient.session_id);assert.equal(data.inbox.messages[0].id,id);
  assert.equal(room.receipts().find(r=>r.eventId===id)?.state,'accepted');
});
test('stale Stop cannot replace a newer busy turn and SessionEnd stops the listener',async t=>{
  const {store}=await fixture(t);
  await claudeSessionHook(store,{session_id:'a',hook_event_name:'UserPromptSubmit',prompt_id:'new-prompt'},process.pid);
  const stale=await claudeSessionHook(store,{session_id:'a',hook_event_name:'Stop',prompt_id:'old-prompt'},process.pid);
  assert.equal(stale.code,0);assert.equal(store.read('a')?.mode,'busy');
  await claudeSessionHook(store,{session_id:'b',hook_event_name:'UserPromptSubmit',prompt_id:'other-prompt'},process.pid);
  assert.equal((await claudeSessionHook(store,{session_id:'a',hook_event_name:'Stop',prompt_id:'new-prompt'},process.pid)).code,0);
  assert.equal(store.current(process.pid),'b','A stale Stop after /clear must not restore the old conversation');
  await claudeSessionHook(store,{session_id:'a',hook_event_name:'SessionEnd'},process.pid);assert.equal(store.read('a')?.mode,'ended');
  await assert.rejects(store.ensure('../escape'),/Invalid Claude/);
});
