import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { SQLite } from './sqlite.js';
import type { BudgetStatus } from '../core/budget.js';

export const budgetPath=()=>join(homedir(),'.relay','shared-request-budget.sqlite3');
export class SharedBudgetPaused extends Error {
  constructor(){super('Relay shared monthly budget is paused. User approval is required; automatic retries are disabled. Queued work is retained.');}
}
export class ClientBudget {
  constructor(readonly path=budgetPath()){}
  private access<T>(f:(db:SQLite)=>T){const db=new SQLite(this.path);try{db.exec('CREATE TABLE IF NOT EXISTS budgets(server TEXT PRIMARY KEY,data TEXT NOT NULL)');return f(db);}finally{db.close();}}
  status(server?:string){return this.access(db=>db.all<{server:string;data:string}>(server?'SELECT * FROM budgets WHERE server=?':'SELECT * FROM budgets',...(server?[new URL(server).origin]:[])).map(r=>({server:r.server,...JSON.parse(r.data)})));}
  assertAllowed(server:string){if(this.status(server)[0]?.paused)throw new SharedBudgetPaused();}
  observe(server:string,status:BudgetStatus){
    if(!status||typeof status.paused!=='boolean'||!Number.isSafeInteger(status.epoch)||!Number.isSafeInteger(status.used))throw Error('Invalid shared budget response');
    const origin=new URL(server).origin;
    const alert=this.access(db=>db.transaction(()=>{
      const raw=db.all<{data:string}>('SELECT data FROM budgets WHERE server=?',origin)[0];const prior=raw?JSON.parse(raw.data) as BudgetStatus:undefined;
      // Delayed responses must not undo a pause or a later approval.
      if(prior&&(prior.epoch>status.epoch||(prior.epoch===status.epoch&&prior.paused&&!status.paused)))return false;
      if(prior&&prior.epoch===status.epoch&&prior.periodStart===status.periodStart&&prior.used>status.used)return false;
      db.exec('INSERT INTO budgets VALUES (?,?) ON CONFLICT(server) DO UPDATE SET data=excluded.data',origin,JSON.stringify(status));
      return status.paused&&status.pauseId!==prior?.pauseId;
    }));
    if(alert){
      const message=new Date().toISOString()+' '+origin+': '+status.message+' Pause ID: '+status.pauseId+'\n';
      console.error(message.trim());
      const dir=dirname(this.path);mkdirSync(dir,{recursive:true});appendFileSync(join(dir,'budget-alerts.log'),message,{mode:0o600});
    }
  }
}
export const clientBudget=new ClientBudget();
export function observeBudgetHeader(server:string,header:string|null,cache=clientBudget){if(header)cache.observe(server,JSON.parse(header));}
