// Owner-only control plane. Credentials are read locally and never sent to peers.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { billingPeriod, type BudgetStatus } from '../core/budget.js';
import { clientBudget, type ClientBudget } from './request-budget.js';

export interface OperatorConfig {server:string;worker:string;accountId:string;secretFile:string;wranglerConfig:string;oauthFile:string;stateFile:string;wranglerCli:string}
interface MonitorState {paused?:boolean;budget?:BudgetStatus;endpointDisabled?:boolean;checkedAt?:string;error?:string;approval?:{approve:true;pauseId:string;extraRequests:number;approvalId:string;reason:string}}
export class BudgetOperator {
  constructor(readonly config:OperatorConfig,readonly cache:ClientBudget=clientBudget){}
  state():MonitorState{return existsSync(this.config.stateFile)?JSON.parse(readFileSync(this.config.stateFile,'utf8')):{};}
  save(state:MonitorState){mkdirSync(dirname(this.config.stateFile),{recursive:true});const temp=this.config.stateFile+'.'+crypto.randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});renameSync(temp,this.config.stateFile);}
  private async exclusive<T>(body:()=>Promise<T>):Promise<T>{
    mkdirSync(dirname(this.config.stateFile),{recursive:true});const lock=this.config.stateFile+'.action.lock';
    if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw Error('Budget control operation already in progress');unlinkSync(lock);}
    const fd=openSync(lock,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);
    try{return await body();}finally{unlinkSync(lock);}
  }
  private token(){
    let text=readFileSync(this.config.oauthFile,'utf8');
    const expiry=text.match(/^expiration_time\s*=\s*"([^"]+)"/m)?.[1];
    if(expiry&&Date.parse(expiry)<Date.now()+300_000){
      const r=spawnSync(process.execPath,[this.config.wranglerCli,'whoami'],{windowsHide:true,stdio:'ignore',timeout:30000});
      if(r.status!==0)throw Error('Cloudflare operator login needs renewal; budget monitor cannot change routing');
      text=readFileSync(this.config.oauthFile,'utf8');
    }
    const token=text.match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];if(!token)throw Error('Missing operator Cloudflare login');return token;
  }
  async cloud(path:string,body?:unknown){
    const response=await fetch('https://api.cloudflare.com/client/v4/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+this.token(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
    const result=await response.json() as any;
    if(!response.ok||result.success===false||result.errors?.length)throw Error(`Cloudflare control-plane request failed (${response.status}): ${result.errors?.map((e:any)=>e.message).join('; ')??'unknown'}`);
    return result;
  }
  async route(enabled:boolean){
    const path=`accounts/${this.config.accountId}/workers/scripts/${this.config.worker}/subdomain`;
    await this.cloud(path,{enabled,previews_enabled:false});
    const check=await this.cloud(path);if(check.result.enabled!==enabled||check.result.previews_enabled)throw Error('Cloudflare endpoint state was not confirmed');
    // Prevent an ordinary subsequent deployment from silently reopening it.
    const config=JSON.parse(readFileSync(this.config.wranglerConfig,'utf8'));config.workers_dev=enabled;config.preview_urls=false;
    writeFileSync(this.config.wranglerConfig,JSON.stringify(config,null,2)+'\n');
  }
  async control(action:string,body?:unknown):Promise<BudgetStatus>{
    const key=JSON.parse(readFileSync(this.config.secretFile,'utf8')).RELAY_CREATE_KEY;if(typeof key!=='string')throw Error('Missing Relay operator key');
    const response=await fetch(this.config.server+'/budget/'+action,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000),redirect:'error'});
    const result=await response.json() as any;if(!response.ok)throw Error(result.error??`Budget control returned ${response.status}`);return result;
  }
  async usage(start:string){
    const result=await this.cloud('graphql',{query:'query Usage($account: string, $start: string, $end: string) { viewer { accounts(filter:{accountTag:$account}) { workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$start,datetime_leq:$end}) { sum { requests } } } } }',variables:{account:this.config.accountId,start,end:new Date().toISOString()}});
    const rows=result.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    if(!Array.isArray(rows)||rows.length>=100)throw Error('Cloudflare usage result is missing or incomplete');
    return Math.ceil(rows.reduce((sum:number,row:any)=>sum+row.sum.requests,0));
  }
  async check(){
    return this.exclusive(()=>this.checkLocked());
  }
  private async checkLocked(){
    const prior=this.state();
    if(prior.paused){
      if(!prior.endpointDisabled){await this.route(false);this.save({...prior,endpointDisabled:true,checkedAt:new Date().toISOString()});}
      return this.state(); // Never poll a stopped Worker or reopen on rollover.
    }
    let budget=await this.control('status');
    if(!budget.configured)throw Error('Shared budget has not been initialized');
    if(!budget.paused){const observed=await this.usage(budget.periodStart);budget=await this.control('reconcile',{used:observed,periodStart:budget.periodStart});}
    if(budget.paused){
      this.save({paused:true,budget,endpointDisabled:false,checkedAt:new Date().toISOString()});
      this.cache.observe(this.config.server,budget);
      await this.route(false);
      this.save({paused:true,budget,endpointDisabled:true,checkedAt:new Date().toISOString()});
    }else this.save({paused:false,budget,endpointDisabled:false,checkedAt:new Date().toISOString()});
    return this.state();
  }
  async resume(approve:boolean,extraRequests:number,reason:string){
    if(!approve)throw Error('Resume requires explicit user approval (--approve).');
    return this.exclusive(()=>this.resumeLocked(extraRequests,reason));
  }
  private async resumeLocked(extraRequests:number,reason:string){
    const state=this.state();if(!state.paused||!state.budget?.pauseId)throw Error('No recorded budget pause to approve');
    const current=billingPeriod(state.budget.billingAnchor,Date.now());
    if(current.periodStart===state.budget.periodStart&&state.budget.used>=state.budget.limit&&extraRequests===0)throw Error('Same period is exhausted: user must explicitly approve an extra request allowance');
    if(!Number.isSafeInteger(extraRequests)||extraRequests<0||!reason.trim())throw Error('Supply a nonnegative extra allowance and an approval reason');
    const approval=state.approval??{approve:true as const,pauseId:state.budget.pauseId,extraRequests,approvalId:crypto.randomUUID(),reason};
    if(approval.extraRequests!==extraRequests||approval.reason!==reason)throw Error('Retry the original recorded approval parameters');
    this.save({...state,approval});
    try{
      await this.route(true);
      const budget=await this.control('resume',approval);if(budget.paused)throw Error('Resume was not confirmed');
      this.cache.observe(this.config.server,budget);this.save({paused:false,budget,endpointDisabled:false,checkedAt:new Date().toISOString()});return budget;
    }catch(error){await this.route(false);throw error;}
  }
}

async function main(){
  const {positionals,values}=parseArgs({allowPositionals:true,options:{config:{type:'string'},approve:{type:'boolean'},'extra-requests':{type:'string'},reason:{type:'string'}}});
  const path=resolve(values.config??'.relay/budget-operator.json');const operator=new BudgetOperator(JSON.parse(readFileSync(path,'utf8')));
  const action=positionals[0]??'status';
  if(action==='status'){console.log(JSON.stringify(operator.state(),null,2));return;}
  if(action==='check'){console.log(JSON.stringify(await operator.check(),null,2));return;}
  if(action==='resume'){console.log(JSON.stringify(await operator.resume(values.approve===true,Number(values['extra-requests']??0),values.reason??''),null,2));return;}
  if(action!=='watch')throw Error('Use status, check, watch, or resume --approve --extra-requests N --reason TEXT');
  const lock=operator.config.stateFile+'.lock';
  if(existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw Error('Budget monitor is already running');unlinkSync(lock);}
  const fd=openSync(lock,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);
  let stopped=false;process.once('SIGINT',()=>stopped=true);process.once('SIGTERM',()=>stopped=true);
  console.log('Shared Relay budget monitor started; no model calls.');
  try{while(!stopped){try{await operator.check();}catch(error){const state=operator.state();operator.save({...state,error:(error as Error).message});console.error(new Date().toISOString(),(error as Error).message);}await new Promise(r=>setTimeout(r,60_000));}}
  finally{unlinkSync(lock);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error((error as Error).message);process.exitCode=1;});
