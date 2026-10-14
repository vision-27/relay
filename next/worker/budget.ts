import { DurableObject } from 'cloudflare:workers';
import { SharedBudget } from '../core/budget.js';
import type { Sql } from '../core/types.js';
import type { ProjectRoom } from './index.js';
interface Env {PROJECTS:DurableObjectNamespace<ProjectRoom>}
export class AccountBudget extends DurableObject<Env> {
  private ledger:SharedBudget;
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    const sql:Sql={all:<T extends object>(s:string,...v:(string|number|null)[])=>Array.from(ctx.storage.sql.exec(s,...v)) as T[],exec:(s,...v)=>{ctx.storage.sql.exec(s,...v);},transaction:<T>(f:()=>T)=>ctx.storage.transactionSync(f)};
    this.ledger=new SharedBudget(sql);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY)');
  }
  async fetch(request:Request){
    try{
      const action=new URL(request.url).pathname;
      const input=request.method==='POST'?await request.json() as any:{};
      if(action==='/initialize')return Response.json(this.ledger.initialize(input.billingAnchor,input.initialUsage));
      if(action==='/resume')return Response.json(this.ledger.resume(input));
      if(action==='/reconcile'){
        const wasPaused=this.ledger.status()?.paused;
        const status=this.ledger.reconcile(input.used,input.periodStart);
        if(status.paused&&!wasPaused)this.announce(status);
        return Response.json(status);
      }
      if(action==='/status')return Response.json(this.ledger.status()??{configured:false,paused:true,message:'Shared budget requires operator configuration'});
      if(action!=='/take')return new Response('Not found',{status:404});
      if(input.projectId)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO projects VALUES (?)',input.projectId);
      const result=this.ledger.take();
      if(result.newlyPaused){
        this.announce(result.status!);
      }
      return Response.json(result);
    }catch(error){return Response.json({error:(error as Error).message},{status:400});}
  }
  private announce(status:import('../core/budget.js').BudgetStatus){
    const projects=Array.from(this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM projects'));
    this.ctx.waitUntil(Promise.allSettled(projects.map(p=>this.env.PROJECTS.get(this.env.PROJECTS.idFromName(p.id)).pauseBudget(status))));
  }
}
