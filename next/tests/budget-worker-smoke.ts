import assert from 'node:assert/strict';
import WebSocket from 'ws';
const server=process.argv[2]??'http://127.0.0.1:8791';
if(!['localhost','127.0.0.1'].includes(new URL(server).hostname))throw Error('Budget exhaustion tests must only run in an isolated local emulator');
const key='local-budget-test',project=crypto.randomUUID();
async function control(action:string,body?:unknown,token=key){return fetch(server+'/budget/'+action,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
async function projectCall(id:string,action:string,token:string,body?:unknown){return fetch(server+'/projects/'+id+'/'+action,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
const initial=await control('initialize',{billingAnchor:'2026-10-06T00:00:00Z',initialUsage:0});assert.equal(initial.status,200,await initial.text());
const created=await projectCall(project,'create',key,{name:'Budget fixture',ownerName:'Fixture',repository:'fixture/repo'});const member=await created.json() as any;assert.equal(created.status,200);
const second=crypto.randomUUID();assert.equal((await projectCall(second,'create',key,{name:'Second project',ownerName:'Fixture',repository:'fixture/second'})).status,200);
const socket=new WebSocket(server.replace('http:','ws:')+'/projects/'+project+'/stream',{headers:{Authorization:'Bearer '+member.token}});
await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
let alert:any;socket.on('message',data=>{const msg=JSON.parse(data.toString());if(msg.type==='budget_paused')alert=msg;});
try{
 const status=await (await control('status')).json() as any;
 const near=await control('reconcile',{used:9_500_000-4,periodStart:status.periodStart});assert.equal(near.status,200);
 const results=await Promise.all(Array.from({length:12},()=>fetch(server+'/health')));
 assert.equal(results.filter(r=>r.status===200).length,4);assert.equal(results.filter(r=>r.status===429).length,8);
 const deadline=Date.now()+3000;while(!alert&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.equal(alert?.budget?.paused,true);
 const stopped=await (await control('status')).json() as any;assert.equal(stopped.paused,true);assert.ok(stopped.used>=9_500_000);
 assert.equal((await projectCall(second,'snapshot',member.token)).status,429);
 assert.equal((await control('resume',{approve:true,pauseId:stopped.pauseId,extraRequests:100,approvalId:'not-owner',reason:'no'},member.token)).status,403);
 assert.equal((await control('resume',{approve:false,pauseId:stopped.pauseId,extraRequests:100,approvalId:'no-approval',reason:'no'})).status,400);
 assert.equal((await control('resume',{approve:true,pauseId:stopped.pauseId,extraRequests:0,approvalId:'no-extra',reason:'no'})).status,400);
 const approved=await control('resume',{approve:true,pauseId:stopped.pauseId,extraRequests:100,approvalId:crypto.randomUUID(),reason:'Isolated local acceptance test'});assert.equal(approved.status,200,await approved.text());
 assert.equal((await fetch(server+'/health')).status,200);
 console.log('PASS: global cross-project threshold, concurrent cutoff, persistent pause, WebSocket alert, operator-only explicit approval, extra allowance, approved resume. Local emulator only.');
}finally{socket.terminate();}
