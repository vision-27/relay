import { DurableObject } from 'cloudflare:workers';
import { Room, routeRoom } from '../core/room.js';
import type { Sql } from '../core/types.js';
import type { BudgetStatus } from '../core/budget.js';
import { AccountBudget } from './budget.js';
import { VERSION } from '../core/version.js';
import { RemoteMcp, routeRemoteMcp } from '../core/remote-mcp.js';
import { remoteConnectPage } from '../core/remote-connect.js';
import { Dashboard, routeDashboard } from '../core/dashboard.js';
import { dashboardPage } from '../core/dashboard-page.js';
import { Companion, routeCompanion } from '../core/companion.js';
export { AccountBudget } from './budget.js';
interface Env { PROJECTS:DurableObjectNamespace<ProjectRoom>; BUDGET:DurableObjectNamespace<AccountBudget>; RELAY_CREATE_KEY:string }
export class ProjectRoom extends DurableObject<Env> {
  private room:Room;
  private mcp:RemoteMcp;
  private dashboard:Dashboard;
  private companion:Companion;
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    const sql:Sql={
      all:<T extends object>(statement:string,...values:(string|number|null)[])=>Array.from(ctx.storage.sql.exec(statement,...values)) as T[],
      exec:(statement,...values)=>{ctx.storage.sql.exec(statement,...values);},
      transaction:<T>(body:()=>T)=>ctx.storage.transactionSync(body)
    };
    this.room=new Room(sql);
    this.mcp=new RemoteMcp(this.room,sql);
    this.dashboard=new Dashboard(this.room,sql);
    this.companion=new Companion(this.room,sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  async fetch(request:Request):Promise<Response> {
    const action=new URL(request.url).pathname.split('/').pop()!;
    if(action==='enroll'){
      if(request.method!=='POST')return new Response('Method not allowed',{status:405});
      try{if(this.room.project().mode!=='network')return new Response('Network invitation required',{status:403});}
      catch{return Response.json({error:'Network not found'},{status:404});}
      return routeRoom(this.room,request,'join');
    }
    if(action==='budgetstatus'){
      try {await this.room.authenticate(request.headers.get('authorization')?.replace(/^Bearer /,'')??'');}
      catch{return Response.json({error:'Project membership required'},{status:403});}
      return this.env.BUDGET.get(this.env.BUDGET.idFromName('account-wide')).fetch('https://budget/status');
    }
    if(action==='stream'||action==='live'){
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
      try {
        const memberId=action==='live'?await this.dashboard.consumeTicket(new URL(request.url).searchParams.get('ticket')??''):(await this.room.authenticate(request.headers.get('authorization')?.replace(/^Bearer /,'')??'')).id;
        if(this.ctx.getWebSockets().length>=64)return new Response('Project connection limit reached',{status:429});
        const pair=new WebSocketPair();const client=pair[0],server=pair[1];
        this.ctx.acceptWebSocket(server);server.serializeAttachment({memberId});server.send('{"type":"changed"}');
        return new Response(null,{status:101,webSocket:client});
      } catch {return new Response('Unauthorized',{status:401});}
    }
    const response=action==='companion'?await routeCompanion(this.companion,this.room,request):action==='dashboard'?await routeDashboard(this.dashboard,this.room,request):action==='mcp'?await routeRemoteMcp(this.mcp,this.room,request):await routeRoom(this.room,request,action,action==='create');
    if(response.ok && request.method==='POST' && action!=='artifacts'&&(!['dashboard','companion'].includes(action)||response.headers.has('X-Relay-Changed'))){
      for(const socket of this.ctx.getWebSockets()){
        try {
          const {memberId}=socket.deserializeAttachment() as {memberId:string};
          if(!this.room.active(memberId)){socket.close(1008,'Membership revoked');continue;}
          socket.send('{"type":"changed"}');
        } catch {socket.close(1011,'Reconnect to resume');}
      }
    }
    return response;
  }
  webSocketMessage(socket:WebSocket) { if(!this.room.active((socket.deserializeAttachment() as {memberId:string}).memberId))socket.close(1008,'Membership revoked'); }
  webSocketClose(socket:WebSocket,code:number){
    // A browser closing without a status reports 1005, which cannot be sent.
    // The runtime may also have already acknowledged the close frame.
    try{socket.close([1005,1006,1015].includes(code)?1000:code);}catch{}
  }
  webSocketError(socket:WebSocket){socket.close(1011,'Reconnect to resume');}
  async pauseBudget(budget:BudgetStatus){
    for(const socket of this.ctx.getWebSockets())try{socket.send(JSON.stringify({type:'budget_paused',budget}));socket.close(4009,'Monthly budget paused; user approval required');}catch{}
  }
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    const url=new URL(request.url);
    const budget=env.BUDGET.get(env.BUDGET.idFromName('account-wide'));
    if(url.pathname.startsWith('/budget/')){
      await budget.fetch(new Request('https://budget/take',{method:'POST',body:'{}'}));
      if(!env.RELAY_CREATE_KEY||request.headers.get('authorization')!==`Bearer ${env.RELAY_CREATE_KEY}`)return Response.json({error:'Operator authorization required'},{status:403});
      const action=url.pathname.slice('/budget'.length);
      if(!['/status','/initialize','/resume','/reconcile'].includes(action))return new Response('Not found',{status:404});
      if((action==='/status'&&request.method!=='GET')||(action!=='/status'&&request.method!=='POST'))return new Response('Method not allowed',{status:405});
      return budget.fetch(new Request('https://budget'+action,request));
    }
    const match=url.pathname.match(/^\/projects\/([a-zA-Z0-9_-]{1,100})\/([a-z]+)$/);
    const decision=await budget.fetch(new Request('https://budget/take',{method:'POST',body:JSON.stringify({projectId:match?.[1]})}));
    if(!decision.ok)return Response.json({error:'Shared budget unavailable; Relay paused'},{status:503});
    const gate=await decision.json() as {allowed:boolean;status:BudgetStatus|null};
    const header=JSON.stringify(gate.status??{configured:false,paused:true,epoch:0,message:'Shared budget requires operator configuration'});
    if(!gate.allowed&&match?.[2]!=='budgetstatus')return Response.json({error:gate.status?.message??'Shared budget requires operator configuration',code:'RELAY_BUDGET_PAUSED',budget:gate.status},{status:429,headers:{'X-Relay-Budget':header}});
    if(url.pathname==='/health')return Response.json({ok:true,version:VERSION,mode:'cloudflare'},{headers:{'X-Relay-Budget':header}});
    if(url.pathname==='/connect'&&request.method==='GET')return remoteConnectPage();
    if((url.pathname==='/app'||url.pathname==='/')&&request.method==='GET')return dashboardPage();
    if(!match)return new Response('Not found',{status:404});
    if(request.headers.has('Origin')&&!(['enroll','dashboard','live'].includes(match[2]!)&&request.headers.get('Origin')===url.origin))return new Response('Origin not allowed',{status:403});
    if(Number(request.headers.get('Content-Length')??0)>40_000)return new Response('Request too large',{status:413});
    if(match[2]==='create' && (!env.RELAY_CREATE_KEY || request.headers.get('authorization')!==`Bearer ${env.RELAY_CREATE_KEY}`))return new Response('Project creation requires the operator key',{status:401});
    const response=await env.PROJECTS.get(env.PROJECTS.idFromName(match[1]!)).fetch(request);
    const result=new Response(response.body,response);result.headers.set('X-Relay-Budget',header);return result;
  }
} satisfies ExportedHandler<Env>;
