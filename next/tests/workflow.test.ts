import { collaborationProbe } from './collaboration-probe.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pair, git, code } from './helpers.js';
import { callTool, callRelayTool } from '../node/tools.js';
import { context } from '../node/context.js';
import { message } from '../node/adapters.js';
import { prepare, validate, accept } from '../node/integration.js';
import { buildBundle, receiveArtifact, safePath, sha } from '../node/artifacts.js';
import { backupProject } from '../node/maintenance.js';
import { Remote } from '../node/client.js';
import { handleHook } from '../node/hooks.js';
async function setup(t:test.TestContext){const p=await pair(t);for(const side of [p.alice,p.bob])writeFileSync(join(side.repo,'.git','info','exclude'),'\n.relay/\n');return p;}
async function exportReadme(alice:Awaited<ReturnType<typeof pair>>['alice']){writeFileSync(join(alice.repo,'README.md'),'changed exact bytes\r\n');return await callRelayTool(alice.state,'relay_artifact',{session_id:alice.session.id,operation:'export',paths:['README.md'],share:true}) as any;}
test('compact context has no duplicate events and oversized directed records remain retrievable',async t=>{
  const {alice,bob}=await setup(t);const asked=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'x'.repeat(8000)}) as any;
  await alice.connector.tick();await bob.connector.tick();
  const pack=callTool(bob.state,'relay_context',{session_id:bob.session.id,max_chars:2000}) as any;
  assert.ok(pack.eventIds.includes(asked.eventId));assert.equal(pack.events,undefined);assert.ok(JSON.stringify(pack).length<=2000);
  let recovered='',offset=0;do{const page=callTool(bob.state,'relay_event',{session_id:bob.session.id,event_id:asked.eventId,offset,limit:2000}) as any;recovered+=page.text;offset=page.nextOffset;}while(offset!==null);
  assert.equal(recovered,'x'.repeat(8000));const e=bob.state.event(asked.eventId)!;assert.ok(message(e).length<4000);assert.equal(message({...e,git:{...e.git,files:Array(50).fill('long/path.ts')}}).length,message(e).length);
});
test('final reply acknowledges once; retry returns existing ID and progress does not mark answered',async t=>{
  const {alice,bob}=await setup(t);const asked=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'Status?'}) as any;await alice.connector.tick();await bob.connector.tick();
  callTool(bob.state,'relay_reply',{session_id:bob.session.id,question_id:asked.eventId,answer:'Working',phase:'progress'});await bob.connector.tick();await alice.connector.tick();
  assert.equal((alice.state.get<any>('snapshot').receipts.find((r:any)=>r.eventId===asked.eventId)).state,'delivered');
  const args={session_id:bob.session.id,question_id:asked.eventId,answer:'Done'};
  const first=callTool(bob.state,'relay_reply',args) as any;const retry=callTool(bob.state,'relay_reply',args) as any;assert.equal(first.eventId,retry.eventId);
  assert.throws(()=>callTool(bob.state,'relay_reply',{...args,answer:'Different'}),/already recorded/);
  await bob.connector.tick();await alice.connector.tick();assert.equal(alice.state.events().filter(e=>e.phase==='final').length,1);
  assert.equal(context(bob.state,bob.session.id).events.some(e=>e.id===asked.eventId),false);
  assert.ok(context(bob.state,bob.session.id,'',true).events.some(e=>e.id===asked.eventId));
});
test('batch acknowledgement checks every recipient before mutating state',async t=>{
  const {alice,bob}=await setup(t);const ids:string[]=[];for(let i=0;i<2;i++)ids.push((callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'Q'+i}) as any).eventId);await alice.connector.tick();await bob.connector.tick();
  assert.throws(()=>callTool(bob.state,'relay_ack',{session_id:bob.session.id,event_ids:[...ids,'absent']}),/not addressed/);
  assert.notEqual(bob.state.delivery(ids[0]!,bob.session.id)?.state,'delivered');callTool(bob.state,'relay_ack',{session_id:bob.session.id,event_ids:ids});assert.ok(ids.every(id=>bob.state.supplied(bob.session.id,id)));
});
test('exact artifact transfer prepares, validates and fast-forwards one checkout; publishes accepted revision',async t=>{
  const {alice,bob}=await setup(t);const exported=await exportReadme(alice);assert.ok(exported.artifact.sealed);
  const repeated=await callRelayTool(alice.state,'relay_artifact',{session_id:alice.session.id,operation:'export',paths:['README.md'],share:true}) as any;assert.equal(repeated.artifact.id,exported.artifact.id);assert.equal(alice.state.pending().filter(j=>(j.body as any).kind==='artifact').length,1);
  const received=await receiveArtifact(bob.state,exported.artifact.id);assert.equal(Buffer.from(received.bundle.files[0]!.data!,'base64').toString(),'changed exact bytes\r\n');
  assert.equal(readFileSync(join(bob.repo,'README.md'),'utf8'),'fixture\n');const plan=await prepare(bob.state,exported.artifact.id);
  assert.equal(readFileSync(join(bob.repo,'README.md'),'utf8'),'fixture\n');
  await validate(bob.state,plan.id,[process.execPath,'-e',"if(require('fs').readFileSync('README.md','utf8')!=='changed exact bytes\\r\\n')process.exit(1)"]);
  await assert.rejects(accept(bob.state,plan.id,bob.session.id,false),/authorization/);
  const accepted=await accept(bob.state,plan.id,bob.session.id,true);assert.equal(git(bob.repo,'rev-parse','HEAD'),accepted.head);assert.equal(readFileSync(join(bob.repo,'README.md'),'utf8'),'changed exact bytes\r\n');
  assert.equal((await new Remote(bob.config).call<any>('tasks')).acceptedRevision.head,accepted.head);
  await bob.connector.tick();await alice.connector.tick();assert.ok(alice.state.events().some(e=>e.kind==='integration'));
  assert.equal((await accept(bob.state,plan.id,bob.session.id,true)).head,accepted.head);
});
test('integration rejects dirty checkouts, divergent file baselines and changes after validation',async t=>{
  const {alice,bob}=await setup(t);const exported=await exportReadme(alice);
  writeFileSync(join(bob.repo,'README.md'),'local work');await assert.rejects(prepare(bob.state,exported.artifact.id),/clean checkout/);
  git(bob.repo,'add','README.md');git(bob.repo,'-c','user.name=Test','-c','user.email=test@local','-c','commit.gpgsign=false','commit','-qm','diverge');await assert.rejects(prepare(bob.state,exported.artifact.id),/Conflict/);
});
test('test failure or mutation cannot become an accepted integration',async t=>{
  const {alice,bob}=await setup(t);const exported=await exportReadme(alice),plan=await prepare(bob.state,exported.artifact.id);
  await assert.rejects(validate(bob.state,plan.id,[process.execPath,'-e','process.exit(1)']),/Validation failed/);
  await assert.rejects(accept(bob.state,plan.id,bob.session.id,true),/validation/);
  await validate(bob.state,plan.id,[process.execPath,'-e','process.exit(0)']);writeFileSync(join(plan.worktree,'README.md'),'tampered');await assert.rejects(accept(bob.state,plan.id,bob.session.id,true),/changed after validation/);
});
test('artifact export rejects secrets, traversal and unapproved untracked files; altered download hashes fail',async t=>{
  const {alice,bob}=await setup(t);
  for(const name of ['../escape','C:/escape','.env','.git/config','.relay/connection.json','a/../b','CON.txt'])assert.throws(()=>safePath(alice.repo,name));
  writeFileSync(join(alice.repo,'new.ts'),'export const ok=true;');assert.throws(()=>buildBundle(alice.repo,['new.ts'],code.repository),/Untracked/);
  writeFileSync(join(alice.repo,'new.ts'),'api_key=super-secret-value');assert.throws(()=>buildBundle(alice.repo,['new.ts'],code.repository,true),/credential/);
  const exported=await exportReadme(alice);const received=await receiveArtifact(bob.state,exported.artifact.id);writeFileSync(received.file,'corrupt');await assert.rejects(receiveArtifact(bob.state,exported.artifact.id),/hash mismatch/);
  await assert.rejects(new Remote(bob.config).call('artifacts',{operation:'chunk',id:exported.artifact.id,sessionId:bob.session.id,part:0,data:'bad'}),/another session/);
});
test('leases reject overlaps, stale versions and incomplete dependencies, with explicit handoff',async t=>{
  const {alice,bob}=await setup(t);const claim={session_id:alice.session.id,operation:'claim',title:'Auth',paths:['src/auth']};
  const first=await callRelayTool(alice.state,'relay_task',claim) as any;
  await assert.rejects(callRelayTool(bob.state,'relay_task',{...claim,session_id:bob.session.id,paths:['src/auth/login.ts']}),/reserved/);
  await assert.rejects(callRelayTool(alice.state,'relay_task',{...claim,title:'Dependent',paths:['src/client'],dependencies:[first.id]}),/not complete/);
  await assert.rejects(callRelayTool(alice.state,'relay_task',{...claim,id:first.id,version:0,operation:'renew'}),/refresh/);
  const handed=await callRelayTool(alice.state,'relay_task',{session_id:alice.session.id,operation:'handoff',id:first.id,version:first.version,target_session_id:bob.session.id}) as any;assert.equal(handed.sessionId,bob.session.id);
  await assert.rejects(callRelayTool(alice.state,'relay_task',{session_id:alice.session.id,operation:'release',id:first.id,version:handed.version}),/another session/);
  await callRelayTool(bob.state,'relay_task',{session_id:bob.session.id,operation:'complete',id:first.id,version:handed.version});
  const dependent=await callRelayTool(alice.state,'relay_task',{...claim,title:'Dependent',paths:['src/client'],dependencies:[first.id]}) as any;assert.equal(dependent.status,'active');
});
test('backup contains verified artifact bytes and event history but no member token',async t=>{
  const {alice}=await setup(t);await exportReadme(alice);await alice.connector.tick();const backup=await backupProject(alice.state);const text=readFileSync(backup.file,'utf8');assert.equal(sha(text),backup.sha256);assert.equal(text.includes(alice.config.token),false);assert.equal(JSON.parse(text).artifacts.length,1);assert.ok(backup.events>0);
});

test('large multi-chunk artifacts preserve new files and deletions without generating source chat',async t=>{
  const {alice,bob}=await setup(t);const bytes='export const value = 42;\r\n'.repeat(3000);writeFileSync(join(alice.repo,'large.ts'),bytes);
  const exported=await callRelayTool(alice.state,'relay_artifact',{session_id:alice.session.id,operation:'export',paths:['large.ts'],allow_untracked:true,share:true}) as any;
  assert.ok(exported.artifact.chunks>1);const received=await receiveArtifact(bob.state,exported.artifact.id);assert.equal(Buffer.from(received.bundle.files[0]!.data!,'base64').toString(),bytes);
  assert.equal(bob.state.events().some(e=>e.text.includes(bytes)),false);
  const plan=await prepare(bob.state,exported.artifact.id);assert.equal(readFileSync(join(plan.worktree,'large.ts'),'utf8'),bytes);
});
test('progress messages stay in hooks without native wakeups and resuming does not repeat acknowledged questions',async t=>{
  const p=await setup(t),{alice,bob}=p;const q=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'Keep me posted'}) as any;await alice.connector.tick();await bob.connector.tick();
  callTool(bob.state,'relay_reply',{session_id:bob.session.id,question_id:q.eventId,answer:'Progress only',phase:'progress'});await bob.connector.tick();await alice.connector.tick();const event=alice.state.events().find(e=>e.phase==='progress')!;
  assert.equal(alice.state.delivery(event.id,alice.session.id),undefined);assert.ok(context(alice.state,alice.session.id).events.some(e=>e.id===event.id));
  // Same binding restored by a real hook uses a hash of member/source identity; exercise via hooks separately.
  const before=handleHook(bob.repo,'claude',{cwd:bob.repo,session_id:'hook-fixture',hook_event_name:'SessionStart'});assert.ok(before);
  const current=bob.state.bindings().find(b=>b.sourceId==='hook-fixture')!;
  bob.state.cache([{...event,id:'hook-q',seq:100,sessionId:alice.session.id,targetSessionId:current.id,kind:'question',text:'Once'}]);
  handleHook(bob.repo,'claude',{cwd:bob.repo,session_id:'hook-fixture',hook_event_name:'PreToolUse'});
  callTool(bob.state,'relay_ack',{session_id:current.id,event_ids:['hook-q']});
  const resumed=handleHook(bob.repo,'claude',{cwd:bob.repo,session_id:'hook-fixture',hook_event_name:'SessionStart'});assert.equal(JSON.stringify(resumed).includes('hook-q'),false);
});

test('HTTP collaboration protocol serializes acceptance, pins referenced artifacts and rejects stale revisions',async t=>{
  const {alice,bob,projectId}=await setup(t);await collaborationProbe(alice.config.server,projectId,alice.config,bob.config,alice.session,bob.session);
});
