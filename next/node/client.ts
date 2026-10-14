import WebSocket from 'ws';
import type { RelayEvent } from '../core/types.js';
import type { Connection } from './state.js';
import { clientBudget, observeBudgetHeader, type ClientBudget } from './request-budget.js';
export class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
export function serverURL(value:string):string {
  const url=new URL(value);
  if(url.username||url.password||url.search||url.hash)throw new Error('Use a service URL without credentials, query parameters or fragments');
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Relay requires HTTPS except for a local development service');
  return url.toString().replace(/\/$/,'');
}
export async function api<T>(server:string,projectId:string,token:string,action:string,body?:unknown,cache:ClientBudget=clientBudget):Promise<T> {
  serverURL(server);cache.assertAllowed(server);
  const response=await fetch(`${serverURL(server)}/projects/${encodeURIComponent(projectId)}/${action}`,{
    method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10_000),redirect:'error'
  });
  observeBudgetHeader(server,response.headers.get('X-Relay-Budget'),cache);
  const result=await response.json().catch(()=>null) as {error?:string}|null;
  if(!response.ok)throw new HttpError(response.status,typeof result?.error==='string'?result.error:`Relay returned HTTP ${response.status}`);
  if(result===null)throw new Error('Relay returned an invalid JSON response');
  return result as T;
}
export class Remote {
  constructor(readonly connection:Connection,readonly budget:ClientBudget=clientBudget) {}
  call<T>(action:string,body?:unknown){const c=this.connection;return api<T>(c.server,c.projectId,c.token,action,body,this.budget);}
  events(after:number){return this.call<{events:RelayEvent[]}>(`events?after=${after}`);}
  async refreshBudget(){
    // Explicit operator/user command only. Normal reconnects never bypass a pause.
    const c=this.connection;
    const response=await fetch(`${serverURL(c.server)}/projects/${encodeURIComponent(c.projectId)}/budgetstatus`,{headers:{Authorization:`Bearer ${c.token}`},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw new HttpError(response.status,'Could not refresh shared budget status');
    const status=await response.json() as import('../core/budget.js').BudgetStatus;
    this.budget.observe(c.server,status);return status;
  }
  subscribe(changed:()=>void,closed:()=>void):WebSocket {
    const c=this.connection,url=new URL(`${serverURL(c.server)}/projects/${c.projectId}/stream`);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    this.budget.assertAllowed(c.server);
    const ws=new WebSocket(url,{headers:{Authorization:`Bearer ${c.token}`},handshakeTimeout:10_000,maxPayload:4096});
    ws.on('upgrade',response=>{const header=response.headers['x-relay-budget'];if(typeof header==='string')observeBudgetHeader(c.server,header,this.budget);});
    ws.on('unexpected-response',(_request,response)=>{try{const header=response.headers['x-relay-budget'];if(typeof header==='string')observeBudgetHeader(c.server,header,this.budget);}finally{response.resume();ws.terminate();}});
    ws.on('message',data=>{try{const message=JSON.parse(data.toString());if(message.type==='budget_paused'){this.budget.observe(c.server,message.budget);ws.close();}}catch{}changed();});
    ws.on('error',()=>{});ws.on('close',closed);return ws;
  }
}
