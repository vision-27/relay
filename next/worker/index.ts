import { DurableObject } from 'cloudflare:workers';
import { Room, routeRoom } from '../core/room.js';
import type { Sql } from '../core/types.js';
interface Env { PROJECTS:DurableObjectNamespace<ProjectRoom>; RELAY_CREATE_KEY:string }
export class ProjectRoom extends DurableObject<Env> {
  private room:Room;
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env);
    const sql:Sql={
      all:<T extends object>(statement:string,...values:(string|number|null)[])=>Array.from(ctx.storage.sql.exec(statement,...values)) as T[],
      exec:(statement,...values)=>{ctx.storage.sql.exec(statement,...values);},
      transaction:<T>(body:()=>T)=>ctx.storage.transactionSync(body)
    };
    this.room=new Room(sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  async fetch(request:Request):Promise<Response> {
    const action=new URL(request.url).pathname.split('/').pop()!;
    if(action==='stream'){
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
      try {
        const member=await this.room.authenticate(request.headers.get('authorization')?.replace(/^Bearer /,'')??'');
        if(this.ctx.getWebSockets().length>=64)return new Response('Project connection limit reached',{status:429});
        const pair=new WebSocketPair();const client=pair[0],server=pair[1];
        this.ctx.acceptWebSocket(server);server.serializeAttachment({memberId:member.id});server.send('{"type":"changed"}');
        return new Response(null,{status:101,webSocket:client});
      } catch {return new Response('Unauthorized',{status:401});}
    }
    const response=await routeRoom(this.room,request,action,action==='create');
    if(response.ok && request.method==='POST'){
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
  webSocketClose(socket:WebSocket,code:number,reason:string){socket.close(code,reason);}
  webSocketError(socket:WebSocket){socket.close(1011,'Reconnect to resume');}
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    const url=new URL(request.url);
    if(url.pathname==='/health')return Response.json({ok:true,version:'0.7.0-alpha.1',mode:'cloudflare'});
    const match=url.pathname.match(/^\/projects\/([a-zA-Z0-9_-]{1,100})\/([a-z]+)$/);
    if(!match)return new Response('Not found',{status:404});
    if(request.headers.has('Origin'))return new Response('Use the Relay connector',{status:403});
    if(Number(request.headers.get('Content-Length')??0)>40_000)return new Response('Request too large',{status:413});
    if(match[2]==='create' && (!env.RELAY_CREATE_KEY || request.headers.get('authorization')!==`Bearer ${env.RELAY_CREATE_KEY}`))return new Response('Project creation requires the operator key',{status:401});
    return env.PROJECTS.get(env.PROJECTS.idFromName(match[1]!)).fetch(request);
  }
} satisfies ExportedHandler<Env>;
