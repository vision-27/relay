import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporary } from './helpers.js';
import { SQLite } from '../node/sqlite.js';
import { SharedBudget, billingPeriod, type BudgetStatus } from '../core/budget.js';
import { ClientBudget, SharedBudgetPaused } from '../node/request-budget.js';
import { api, Remote } from '../node/client.js';
import { BudgetOperator, type OperatorConfig } from '../node/budget-operator.js';

test('shared monthly budget aggregates callers, pauses at threshold, survives restart and rollover',t=>{
 const temp=temporary(),path=join(temp.dir,'shared.db'),db=new SQLite(path);t.after(()=>{db.close();temp.cleanup();});
 const now=Date.UTC(2026,9,6,12),ledger=new SharedBudget(db,3);
 ledger.initialize('2026-10-06T00:00:00Z',0,now);
 assert.equal(ledger.take(now).allowed,true);
 assert.equal(new SharedBudget(db,3).take(now).allowed,true);
 const last=ledger.take(now);assert.equal(last.allowed,true);assert.equal(last.status?.paused,true);
 assert.equal(ledger.take(now).allowed,false);
 const next=ledger.status(Date.UTC(2026,10,6,1))!;
 assert.equal(next.used,0);assert.equal(next.paused,true);assert.equal(next.pauseId,last.status?.pauseId);
 assert.throws(()=>ledger.resume({approve:false,pauseId:next.pauseId!,extraRequests:0,approvalId:'x',reason:'test'},now),/approval/);
 const approved=ledger.resume({approve:true,pauseId:next.pauseId!,extraRequests:0,approvalId:'x',reason:'User approved new period'},Date.UTC(2026,10,6,1));
 assert.equal(approved.paused,false);assert.equal(approved.epoch,1);
});

test('same-month resume requires an explicit extra allowance; approval retry cannot double it',t=>{
 const temp=temporary(),db=new SQLite(join(temp.dir,'budget.db'));t.after(()=>{db.close();temp.cleanup();});const ledger=new SharedBudget(db,3),now=Date.UTC(2026,9,6,12);
 ledger.initialize('2026-10-06T00:00:00Z',3,now);const status=ledger.status(now)!;
 const input={approve:true,pauseId:status.pauseId!,extraRequests:0,approvalId:'approval',reason:'Explicit user approval'};
 assert.throws(()=>ledger.resume(input,now),/extra requests/);
 assert.throws(()=>ledger.resume({...input,pauseId:'wrong',extraRequests:2},now),/current pause/);
 const approved={...input,extraRequests:2};assert.equal(ledger.resume(approved,now).limit,5);assert.equal(ledger.resume(approved,now).limit,5);
 assert.throws(()=>ledger.initialize('2026-10-06T00:00:00Z',0,now),/already configured/);
 assert.throws(()=>ledger.resume({...approved,extraRequests:10},now),/different input/);
});

test('renewal day handles short months and usage reconciliation never decreases the counter',t=>{
 assert.deepEqual(billingPeriod('2026-01-31T00:00:00Z',Date.UTC(2026,1,28,1)),{periodStart:'2026-02-28T00:00:00.000Z',periodEnd:'2026-03-31T00:00:00.000Z'});
 const temp=temporary(),db=new SQLite(join(temp.dir,'budget.db'));t.after(()=>{db.close();temp.cleanup();});const ledger=new SharedBudget(db,10),now=Date.UTC(2026,9,6,12);
 const s=ledger.initialize('2026-10-06T00:00:00Z',5,now);
 assert.equal(ledger.reconcile(2,s.periodStart,now).used,5);
 assert.equal(ledger.reconcile(10,s.periodStart,now).paused,true);
 assert.throws(()=>ledger.reconcile(10,'2026-09-06T00:00:00.000Z',now),/different billing period/);
});

test('cached shared pause blocks HTTP and WebSockets across local restarts and stale responses',async t=>{
 const path=join(temporary(t).dir,'client.db'),cache=new ClientBudget(path),server='https://relay.invalid';
 const active:BudgetStatus={configured:true,billingAnchor:'2026-10-06T00:00:00Z',periodStart:'2026-10-06T00:00:00Z',periodEnd:'2026-11-06T00:00:00Z',used:1,limit:3,paused:false,pauseId:null,epoch:0,message:'active',seededUsage:0};
 cache.observe(server,{...active,used:3,paused:true,pauseId:'test-pause',message:'Test budget exhausted'});
 cache.observe(server,active);
 let fetches=0;t.mock.method(globalThis,'fetch',async()=>{fetches++;return new Response('{}');});
 await assert.rejects(api(server,'p','t','snapshot',undefined,new ClientBudget(path)),SharedBudgetPaused);
 const remote=new Remote({server,projectId:'p',token:'t',memberId:'m',repository:'r',name:'n',repo:'.'},cache);
 assert.throws(()=>remote.subscribe(()=>{},()=>{}),SharedBudgetPaused);assert.equal(fetches,0);
 cache.observe(server,{...active,epoch:1,limit:5});await api(server,'p','t','snapshot',undefined,cache);assert.equal(fetches,1);
 cache.observe(server,{...active,paused:true,pauseId:'old-pause',epoch:0});assert.equal(cache.status(server)[0].paused,false);
});

test('owner monitor disables endpoint on pause and never auto-resumes, even after month changes',async t=>{
 const dir=temporary(t).dir;
 const config:OperatorConfig={server:'https://relay.invalid',worker:'fixture',accountId:'fixture',secretFile:'unused',wranglerConfig:'unused',oauthFile:'unused',wranglerCli:'unused',stateFile:join(dir,'state.json')};
 const operator=new BudgetOperator(config,new ClientBudget(join(dir,'client.db')));let calls=0;const routes:boolean[]=[];
 const paused={configured:true,billingAnchor:'2026-10-06T00:00:00Z',periodStart:'2026-10-06T00:00:00Z',periodEnd:'2026-11-06T00:00:00Z',used:9500000,limit:9500000,paused:true,pauseId:'monitor-test',epoch:0,message:'test',seededUsage:0} as BudgetStatus;
 t.mock.method(operator,'control',async()=>{calls++;return paused;});
 t.mock.method(operator,'route',async(enabled:boolean)=>{routes.push(enabled);});
 await operator.check();await operator.check();assert.deepEqual(routes,[false]);assert.equal(calls,1);
 await assert.rejects(operator.resume(false,100,'test'),/approval/);assert.deepEqual(routes,[false]);
});
