// Explicit operator acceptance against a deployed service. Every record belongs
// to a new fixture project; existing projects and real agents are never touched.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { api, serverURL, HttpError } from '../node/client.js';
import { binding, code } from './helpers.js';
import type { RelayEvent, Receipt } from '../core/types.js';

const [deploymentFile,secretFile,proofFile]=process.argv.slice(2);
if(!deploymentFile||!secretFile||!proofFile)throw new Error('Usage: hosted-smoke DEPLOYMENT_JSON OPERATOR_SECRET_JSON PROOF_JSON');
const deployment=JSON.parse(readFileSync(deploymentFile,'utf8'));
const server=serverURL(deployment.server),url=new URL(server);
if(url.protocol!=='https:'||!url.hostname.endsWith('.workers.dev'))throw new Error('This acceptance test requires the explicitly supplied Cloudflare deployment');
const key=JSON.parse(readFileSync(secretFile,'utf8')).RELAY_CREATE_KEY;
if(typeof key!=='string'||key.length<32)throw new Error('Missing local operator key');
const project=crypto.randomUUID(),started=Date.now();
const errorStatus=(status:number)=>(error:unknown)=>error instanceof HttpError&&error.status===status;
async function bounded<T>(promise:Promise<T>,label:string):Promise<T>{
  let timer:NodeJS.Timeout;
  return Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),10000);})]).finally(()=>clearTimeout(timer));
}
const health=await fetch(server+'/health',{signal:AbortSignal.timeout(10000)});
assert.equal(health.status,200);assert.equal((await health.json() as any).mode,'cloudflare');
await assert.rejects(api(server,project,'','create',{name:'Unauthorized fixture',ownerName:'Fixture',repository:code.repository}),errorStatus(401));
const a=await api<{token:string;memberId:string}>(server,project,key,'create',{name:'Hosted acceptance fixture',ownerName:'Fixture Alice',repository:code.repository});
const invite=await api<{code:string}>(server,project,a.token,'invite',{});
await assert.rejects(api(server,project,'','join',{code:invite.code,name:'Wrong repository',repository:'different/repository'}),errorStatus(409));
const b=await api<{token:string;memberId:string}>(server,project,'','join',{code:invite.code,name:'Fixture Bob',repository:code.repository});
await assert.rejects(api(server,project,'','join',{code:invite.code,name:'Reused invitation',repository:code.repository}),errorStatus(403));
const alice=binding(a.memberId,'codex'),bob=binding(b.memberId,'claude');
await api(server,project,a.token,'sessions',alice);await api(server,project,b.token,'sessions',bob);
const socket=new WebSocket(server.replace(/^https:/,'wss:')+`/projects/${project}/stream`,{headers:{Authorization:`Bearer ${b.token}`},handshakeTimeout:10000});
let notifications=0;socket.on('message',()=>notifications++);
try {
  await bounded(new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);}), 'WebSocket connection');
  const before=notifications;
  const event={id:crypto.randomUUID(),sessionId:alice.id,targetSessionId:bob.id,kind:'question',text:'Hosted fixture: verify durable question and reply.',paths:[],git:code};
  const sent=await api<RelayEvent>(server,project,a.token,'events',event);
  const duplicate=await api<RelayEvent>(server,project,a.token,'events',event);assert.equal(sent.seq,duplicate.seq);
  await assert.rejects(api(server,project,a.token,'events',{...event,text:'Conflicting reuse'}),errorStatus(409));
  const replay=await api<{events:RelayEvent[]}>(server,project,b.token,'events?after=0');assert.equal(replay.events.length,1);assert.equal(replay.events[0]!.id,sent.id);
  await assert.rejects(api(server,project,a.token,'receipts',{eventId:sent.id,sessionId:bob.id,state:'delivered',detail:'Wrong recipient'}),errorStatus(403));
  await api(server,project,b.token,'receipts',{eventId:sent.id,sessionId:bob.id,state:'delivered',detail:'Fixture receipt; no real agent'});
  const reply=await api<RelayEvent>(server,project,b.token,'events',{id:crypto.randomUUID(),sessionId:bob.id,targetSessionId:alice.id,replyTo:sent.id,kind:'reply',text:'Hosted fixture reply.',paths:[]});
  const reconnect=await api<{events:RelayEvent[]}>(server,project,a.token,`events?after=${sent.seq}`);assert.equal(reconnect.events.length,1);assert.equal(reconnect.events[0]!.id,reply.id);
  const snapshot=await api<{receipts:Receipt[]}>(server,project,a.token,'snapshot');assert.equal(snapshot.receipts.find(r=>r.eventId===sent.id)?.state,'answered');
  await assert.rejects(api(server,crypto.randomUUID(),a.token,'snapshot'),errorStatus(401));
  assert.ok(notifications>before,'No event invalidation reached the connected client');
  const closed=bounded(new Promise<number>(resolve=>socket.once('close',code=>resolve(code))),'Revoked socket closure');
  await api(server,project,a.token,'revoke',{memberId:b.memberId});assert.equal(await closed,1008);
  await assert.rejects(api(server,project,b.token,'snapshot'),errorStatus(401));
  await api(server,project,a.token,'sessions',{...alice,state:'closed'});
  const proof={server,projectId:project,verifiedAt:new Date().toISOString(),durationMs:Date.now()-started,checks:['HTTPS health','operator creation gate','repository identity','single-use invite','authenticated WebSocket invalidation','idempotent append','conflicting reuse rejection','ordered reconnect replay','recipient ownership','source reply receipt','project isolation','revoked token and socket'],realAgentUsed:false,retainedFixtureEvents:2};
  writeFileSync(proofFile,JSON.stringify(proof,null,2)+'\n',{mode:0o600});
  console.log(`Hosted Cloudflare acceptance PASS: ${proof.checks.join(', ')}. Two fixture events retained in a new isolated project; no real agents or existing project data used.`);
}finally{socket.terminate();}
