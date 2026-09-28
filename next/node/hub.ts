import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Room, routeRoom } from '../core/room.js';
import { SQLite } from './sqlite.js';
import { id } from '../core/types.js';
export async function startHub(dir:string,createKey:string,port=0):Promise<{url:string;server:Server;close:()=>Promise<void>}> {
  mkdirSync(dir,{recursive:true}); const rooms=new Map<string,{room:Room;db:SQLite}>(), clients=new Map<WebSocket,{projectId:string;token:string}>();
  const get=(projectId:string)=>{
    id(projectId); let value=rooms.get(projectId);
    if(!value) { const db=new SQLite(join(dir,`${projectId}.sqlite3`)); value={room:new Room(db),db};rooms.set(projectId,value); } return value.room;
  };
  const sockets=new WebSocketServer({noServer:true,maxPayload:4096});
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url??'/',`http://127.0.0.1`);
      if(url.pathname==='/health') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ok:true,version:'0.7.0-alpha.1',mode:'local'}));return; }
      const match=url.pathname.match(/^\/projects\/([a-zA-Z0-9_-]+)\/([a-z]+)$/);
      if(!match) { res.writeHead(404).end();return; }
      const projectId=match[1]!,action=match[2]!; let data='';
      for await(const chunk of req) {data+=chunk;if(data.length>40_000){res.writeHead(413).end();return;}}
      const headers=new Headers(); for(const [key,val] of Object.entries(req.headers)) if(typeof val==='string')headers.set(key,val);
      if(action==='create' && headers.get('authorization')!==`Bearer ${createKey}`) {res.writeHead(401).end();return;}
      const response=await routeRoom(get(projectId),new Request(url,{method:req.method,headers,...(req.method==='POST'?{body:data}:{})}),action,action==='create');
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
      if(response.ok && req.method==='POST') for(const [ws,client] of clients) if(client.projectId===projectId){
        try { await get(projectId).authenticate(client.token); if(ws.readyState===WebSocket.OPEN)ws.send('{"type":"changed"}'); }
        catch {ws.close(1008,'Membership revoked');}
      }
    } catch {res.writeHead(400).end(JSON.stringify({error:'Invalid request'}));}
  });
  server.on('upgrade',async(req,socket,head)=>{
    try {
      const match=new URL(req.url??'/', 'http://localhost').pathname.match(/^\/projects\/([a-zA-Z0-9_-]+)\/stream$/);
      if(!match)throw new Error('Not found'); const token=(req.headers.authorization??'').replace(/^Bearer /,'');await get(match[1]!).authenticate(token);
      sockets.handleUpgrade(req,socket,head,ws=>{clients.set(ws,{projectId:match[1]!,token});ws.on('close',()=>clients.delete(ws));ws.send('{"type":"changed"}');});
    } catch {socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();}
  });
  await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  let closed=false;
  return {url:`http://127.0.0.1:${address.port}`,server,close:async()=>{
    if(closed)return;closed=true;
    for(const ws of clients.keys())ws.terminate(); await new Promise<void>(resolve=>server.close(()=>resolve()));sockets.close();for(const value of rooms.values())value.db.close();
  }};
}
