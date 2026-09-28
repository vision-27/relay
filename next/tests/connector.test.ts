import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pair } from './helpers.js';
import { callTool } from '../node/tools.js';
import { State, stateDir } from '../node/state.js';
import { Connector } from '../node/connector.js';
import { Remote } from '../node/client.js';
import { context } from '../node/context.js';
import type { RelayEvent } from '../core/types.js';
import { startHub } from '../node/hub.js';
import { join } from 'node:path';
test('two checkouts exchange source-attributed questions, explicit receipts and replies',async t=>{
  let offers=0;const {alice,bob}=await pair(t,async()=>{offers++;return {state:'accepted',detail:'Fixture accepted'};});
  const asked=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'What is the new login contract?'}) as {eventId:string};
  await alice.connector.tick();await bob.connector.tick();await bob.connector.tick();await alice.connector.tick();
  assert.equal(offers,1);assert.equal(bob.state.delivery(asked.eventId,bob.session.id)?.state,'accepted');
  callTool(bob.state,'relay_ack',{session_id:bob.session.id,event_id:asked.eventId});
  callTool(bob.state,'relay_reply',{session_id:bob.session.id,question_id:asked.eventId,answer:'User object plus HTTP-only cookie; no token field',evidence:'Decision recorded in this session'});
  await bob.connector.tick();await alice.connector.tick();
  const replies=alice.state.events().filter(e=>e.replyTo===asked.eventId);assert.equal(replies.length,1);assert.equal(replies[0]?.sessionId,bob.session.id);
  assert.equal((alice.state.get<any>('snapshot')).receipts.find((r:any)=>r.eventId===asked.eventId).state,'answered');
  assert.match(context(alice.state,alice.session.id,'login',true).text,/HTTP-only cookie/);
});
test('outbox and captured source revision survive restart before synchronization',async t=>{
  const {alice,bob}=await pair(t);
  const original=bob.session.git;
  const posted=callTool(bob.state,'relay_publish',{session_id:bob.session.id,kind:'contract',text:'Use accountId',paths:['src/auth']}) as {eventId:string};
  const current=bob.state.binding(bob.session.id);current.git={...current.git,head:'d'.repeat(40)};bob.state.bind(current);
  const reopened=new State(stateDir(bob.repo));const second=new Connector(reopened,new Remote(bob.config),async()=>({state:'accepted',detail:'Fixture'}));
  try{await second.tick();await alice.connector.tick();assert.equal(alice.state.event(posted.eventId)?.git.head,original.head);assert.equal(reopened.pending().length,0);}
  finally{await second.stop();reopened.close();}
});
test('ambiguous native delivery does not get automatically sent again',async t=>{
  let attempts=0;const {alice,bob}=await pair(t,async()=>{attempts++;throw new Error('connection lost after write');});
  const result=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'Check authentication'}) as {eventId:string};
  await alice.connector.tick();await bob.connector.tick();await bob.connector.tick();
  assert.equal(attempts,1);assert.equal(bob.state.delivery(result.eventId,bob.session.id)?.state,'uncertain');
  assert.match(context(bob.state,bob.session.id).text,/Check authentication/);
});
test('replay drains every page and older searchable evidence remains available',async t=>{
  const {alice,bob}=await pair(t);
  for(let i=0;i<425;i++)alice.state.publish({id:crypto.randomUUID(),sessionId:alice.session.id,kind:'observation',text:i===0?'Unique historic cookie rationale':`Event ${i}`,paths:[]});
  const started=performance.now();for(let i=0;i<5;i++)await alice.connector.tick();await bob.connector.tick();
  assert.equal(bob.state.get('cursor'),425);assert.equal(bob.state.events().length,425);
  assert.ok(bob.state.search('historic cookie').some(e=>e.text.includes('Unique historic')));
  t.diagnostic(`425-event append and replay: ${Math.round(performance.now()-started)} ms on this machine; not a hosted latency benchmark`);
});
test('idle local ticks do not keep polling the remote service',async t=>{
  const {alice}=await pair(t);let requests=0;const original=alice.connector.remote.call.bind(alice.connector.remote);
  alice.connector.remote.call=(...args:any[])=>{requests++;return original(args[0],args[1]);};
  for(let i=0;i<25;i++)await alice.connector.tick(false);assert.equal(requests,0);
  const previous=alice.state.get<{json:string;at:number}>(`registered:${alice.session.id}`)!;
  alice.state.set(`registered:${alice.session.id}`,{...previous,at:Date.now()-60_000});
  let registrations=0;alice.connector.remote.call=(...args:any[])=>{if(args[0]==='sessions')registrations++;return original(args[0],args[1]);};
  await alice.connector.tick();assert.equal(registrations,0,'reconciliation must not rewrite unchanged sessions');
});
test('superseded decisions are removed from the brief and source dirty changes remain explicit',async t=>{
  const {alice,bob}=await pair(t);
  const old=callTool(alice.state,'relay_publish',{session_id:alice.session.id,kind:'decision',text:'Use local storage',paths:[]}) as {eventId:string};await alice.connector.tick();
  callTool(alice.state,'relay_publish',{session_id:alice.session.id,kind:'decision',text:'Use secure cookies instead',paths:[],supersedes:old.eventId});await alice.connector.tick();await bob.connector.tick();
  const pack=context(bob.state,bob.session.id,'',true);assert.equal(pack.events.some(e=>e.id===old.eventId),false);assert.match(pack.text,/secure cookies/);
});
test('network outage retains a question and server restart replays it exactly once',async t=>{
  let offers=0;const {alice,bob,hub,key,temp}=await pair(t,async()=>{offers++;return {state:'accepted',detail:'Fixture'};});
  await hub.close();
  const question=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'Question created while offline'}) as {eventId:string};
  await alice.connector.tick();assert.equal(alice.state.pending().length,1);assert.ok(alice.state.get('syncError'));
  const restarted=await startHub(join(temp.dir,'hub'),key,Number(new URL(hub.url).port));
  try{
    await alice.connector.tick();await bob.connector.tick();await bob.connector.tick();
    assert.equal(alice.state.pending().length,0);assert.equal(offers,1);assert.equal(bob.state.events().filter(e=>e.id===question.eventId).length,1);
  }finally{await restarted.close();}
});
test('background connectors receive WebSocket invalidations and deliver without manual polling',async t=>{
  const {alice,bob}=await pair(t);alice.connector.start();bob.connector.start();
  const question=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'Live background delivery'}) as {eventId:string};
  const deadline=Date.now()+8000;
  while(!bob.state.delivery(question.eventId,bob.session.id)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));
  assert.equal(bob.state.delivery(question.eventId,bob.session.id)?.state,'accepted');
});
