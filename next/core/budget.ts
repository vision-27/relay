import type { Sql } from './types.js';

export const MONTHLY_REQUEST_LIMIT=9_500_000;
export interface BudgetStatus {
  configured:true; billingAnchor:string; periodStart:string; periodEnd:string;
  used:number; limit:number; paused:boolean; pauseId:string|null; epoch:number;
  message:string; seededUsage:number;
}
export function billingPeriod(anchor:string,now:number) {
  const origin=new Date(anchor);if(!Number.isFinite(origin.getTime()))throw Error('Invalid billing anchor');
  const date=new Date(now);
  const boundary=(year:number,month:number)=>Date.UTC(year,month,Math.min(origin.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate()),origin.getUTCHours(),origin.getUTCMinutes(),origin.getUTCSeconds());
  let year=date.getUTCFullYear(),month=date.getUTCMonth();
  if(now<boundary(year,month)){month--;if(month<0){month=11;year--;}}
  return {periodStart:new Date(boundary(year,month)).toISOString(),periodEnd:new Date(boundary(year,month+1)).toISOString()};
}
export class SharedBudget {
  constructor(private sql:Sql,private baseLimit=MONTHLY_REQUEST_LIMIT) {
    sql.exec('CREATE TABLE IF NOT EXISTS budget_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS budget_audit (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL)');
  }
  private load():BudgetStatus|null {const r=this.sql.all<{data:string}>('SELECT data FROM budget_state WHERE id=1')[0];return r?JSON.parse(r.data):null;}
  private save(s:BudgetStatus){this.sql.exec('INSERT INTO budget_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',JSON.stringify(s));}
  private roll(s:BudgetStatus,now:number) {
    const p=billingPeriod(s.billingAnchor,now);
    if(p.periodStart>s.periodStart){
      this.sql.exec('INSERT OR IGNORE INTO budget_audit VALUES (?,?,?)','period:'+s.periodStart,'period',JSON.stringify(s));
      Object.assign(s,p,{used:0,limit:this.baseLimit,seededUsage:0});
      // A threshold pause survives rollover. Only explicit approval clears it.
    }
  }
  private latch(s:BudgetStatus,now:number) {
    if(!s.paused&&s.used>=s.limit){
      s.paused=true;s.pauseId=crypto.randomUUID();
      s.message=`Relay paused at its shared monthly request budget (${s.used}/${s.limit}). Explicit user approval is required to resume.`;
      this.sql.exec('INSERT INTO budget_audit VALUES (?,?,?)',s.pauseId,'alert',JSON.stringify({...s,at:new Date(now).toISOString()}));
    }
  }
  initialize(anchor:string,used:number,now=Date.now()) {
    if(!Number.isSafeInteger(used)||used<0)throw Error('Initial usage must be a nonnegative integer');
    return this.sql.transaction(()=>{
      if(this.load())throw Error('Shared budget already configured; initialization cannot reset usage');
      const s:BudgetStatus={configured:true,billingAnchor:new Date(anchor).toISOString(),...billingPeriod(anchor,now),used,limit:this.baseLimit,paused:false,pauseId:null,epoch:0,message:'Shared monthly budget active',seededUsage:used};
      this.latch(s,now);this.save(s);return s;
    });
  }
  status(now=Date.now()) {
    return this.sql.transaction(()=>{const s=this.load();if(!s)return null;this.roll(s,now);this.save(s);return s;});
  }
  take(now=Date.now()) {
    return this.sql.transaction(()=>{
      const s=this.load();if(!s)return {allowed:false,status:null,newlyPaused:false};
      this.roll(s,now);const allowed=!s.paused,previous=s.paused;
      // Rejected incoming invocations still count at Cloudflare.
      s.used++;this.latch(s,now);this.save(s);
      return {allowed,status:s,newlyPaused:!previous&&s.paused};
    });
  }
  reconcile(observed:number,periodStart:string,now=Date.now()){
    if(!Number.isSafeInteger(observed)||observed<0)throw Error('Invalid observed usage');
    return this.sql.transaction(()=>{const s=this.load();if(!s)throw Error('Configure the shared budget first');this.roll(s,now);
      if(s.periodStart!==periodStart)throw Error('Usage sample belongs to a different billing period');
      s.used=Math.max(s.used,observed);this.latch(s,now);this.save(s);return s;
    });
  }
  resume(input:{approve:boolean;pauseId:string;extraRequests:number;approvalId:string;reason:string},now=Date.now()) {
    if(input.approve!==true||!input.reason?.trim()||!input.approvalId)throw Error('Explicit user approval and reason are required');
    if(!Number.isSafeInteger(input.extraRequests)||input.extraRequests<0)throw Error('Invalid extra request allowance');
    return this.sql.transaction(()=>{
      const prior=this.sql.all<{data:string}>('SELECT data FROM budget_audit WHERE id=?',input.approvalId)[0];
      if(prior){const record=JSON.parse(prior.data);if(JSON.stringify(record.input)!==JSON.stringify(input))throw Error('Approval ID reused with different input');return this.load()!;}
      const s=this.load();if(!s)throw Error('Configure the shared budget first');this.roll(s,now);
      if(!s.paused||s.pauseId!==input.pauseId)throw Error('Approval does not match the current pause');
      if(s.used>=s.limit&&input.extraRequests===0)throw Error('This billing period is exhausted; explicitly approve extra requests or wait for the next period');
      if(s.limit+input.extraRequests>Number.MAX_SAFE_INTEGER)throw Error('Allowance is too large');
      s.limit+=input.extraRequests;if(s.used>=s.limit)throw Error('Extra allowance must exceed current usage');
      s.paused=false;s.pauseId=null;s.epoch++;s.message='Resumed with explicit user approval';
      this.sql.exec('INSERT INTO budget_audit VALUES (?,?,?)',input.approvalId,'approval',JSON.stringify({input,at:new Date(now).toISOString(),status:s}));this.save(s);return s;
    });
  }
}
