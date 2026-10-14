import assert from 'node:assert/strict';
import { api } from '../node/client.js';
import { hash } from '../core/types.js';
import type { Session } from '../core/types.js';
export async function collaborationProbe(server:string,project:string,a:{token:string;memberId:string},b:{token:string;memberId:string},alice:Session,bob:Session){
  const request=(token:string,action:string,body?:unknown)=>api<any>(server,project,token,action,body);
  const task=await request(a.token,'tasks',{sessionId:alice.id,title:'Probe',paths:['src/auth'],ttlSeconds:60});
  await assert.rejects(request(b.token,'tasks',{sessionId:bob.id,title:'Overlap',paths:['src/auth/login.ts']}),/reserved/);
  await request(a.token,'tasks',{sessionId:alice.id,operation:'complete',id:task.id,version:task.version});
  const payload='exact fixture bytes '.repeat(3000),digest=await hash(payload),id=crypto.randomUUID(),chunks=Math.ceil(payload.length/24000);
  await request(a.token,'artifacts',{operation:'begin',sessionId:alice.id,id,source:alice.git,paths:['README.md'],sha256:digest,size:payload.length,chunks});
  await assert.rejects(request(b.token,`artifacts?id=${id}&part=0`),/incomplete/);
  for(let part=0;part<chunks;part++)await request(a.token,'artifacts',{operation:'chunk',sessionId:alice.id,id,part,data:payload.slice(part*24000,(part+1)*24000)});
  await request(a.token,'artifacts',{operation:'seal',sessionId:alice.id,id});let restored='';for(let part=0;part<chunks;part++)restored+=(await request(b.token,`artifacts?id=${id}&part=${part}`)).data;assert.equal(await hash(restored),digest);
  await assert.rejects(request(b.token,'artifacts',{operation:'chunk',sessionId:bob.id,id,part:0,data:'bad'}),/another session/);
  const integrationId=crypto.randomUUID();await request(b.token,'integrations',{operation:'reserve',id:integrationId,sessionId:bob.id,artifactId:id,baseHead:bob.git.head});
  await assert.rejects(request(a.token,'integrations',{operation:'reserve',id:crypto.randomUUID(),sessionId:alice.id,artifactId:id,baseHead:alice.git.head}),/Another integration/);
  const head='e'.repeat(40);await request(b.token,'sessions',{...bob,git:{...bob.git,head,dirty:false}});
  const input={id:integrationId,sessionId:bob.id,artifactId:id,baseHead:bob.git.head,head,validation:{exitCode:0,command:['fixture-only'],outputHash:await hash('fixture')}};
  await request(b.token,'integrations',input);await request(b.token,'integrations',{...input,operation:'reserve'});await request(b.token,'integrations',input);
  const shared=await request(a.token,'snapshot');assert.equal(shared.acceptedRevision.head,head);assert.equal(shared.protocol,2);
  await assert.rejects(request(a.token,'tasks',{sessionId:alice.id,title:'Stale',paths:['other']}),/stale/);
  await assert.rejects(request(a.token,'artifacts',{operation:'delete',sessionId:alice.id,id,archivedHash:digest}),/referenced/);
  return {artifactChunks:chunks,protocol:shared.protocol,scopes:true,concurrentAcceptance:true,staleRevision:true};
}
