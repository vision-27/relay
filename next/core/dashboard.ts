import { Room } from './room.js';
import { assert, bounded, hash, id, RelayError, secret, type Member, type RelayEvent, type Session, type Sql } from './types.js';

/** The browser acts as a person, never as one of the member's coding agents. */
export class Dashboard {
  constructor(private room:Room,private sql:Sql) {
    sql.exec('CREATE TABLE IF NOT EXISTS browser_tickets (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  async ticket(member:Member) {
    const token=secret(),digest=await hash(token),expires=Date.now()+30_000;
    this.sql.exec('DELETE FROM browser_tickets WHERE expires<=?',Date.now());
    assert(this.sql.all<{n:number}>('SELECT count(*) AS n FROM browser_tickets WHERE member_id=?',member.id)[0]!.n<8,429,'Too many pending connections; try again shortly');
    this.sql.exec('INSERT INTO browser_tickets VALUES (?,?,?)',digest,member.id,expires);
    return {ticket:token,expiresAt:expires};
  }
  async consumeTicket(token:string):Promise<string> {
    const digest=await hash(bounded(token,128));
    return this.sql.transaction(()=>{
      const row=this.sql.all<{member_id:string;expires:number}>('SELECT member_id,expires FROM browser_tickets WHERE hash=?',digest)[0];
      assert(row&&row.expires>Date.now()&&this.room.active(row.member_id),401,'Connection ticket expired; reconnect');
      this.sql.exec('DELETE FROM browser_tickets WHERE hash=?',digest);return row.member_id;
    });
  }
  private human(member:Member):Session {
    const sessionId='human_'+member.id;
    return this.room.register(member,{id:sessionId,memberId:member.id,provider:'human',sourceId:sessionId,name:member.name,task:'Coordinating in the shared room',scopes:[],state:'idle',updatedAt:new Date().toISOString(),git:{repository:'Relay room',head:null,branch:null,dirty:false,files:[],fingerprint:''}});
  }
  async call(member:Member,input:Record<string,unknown>,url:URL) {
    assert(this.room.project().mode==='network',403,'Shared rooms require a Relay network');
    const operation=input.operation;
    if(operation==='ticket')return this.ticket(member);
    if(operation==='invite'){
      const invitation=await this.room.invite(member),projectId=url.pathname.split('/')[2]!;
      return {url:`${url.origin}/connect#${encodeURIComponent(JSON.stringify({projectId,code:invitation.code}))}`,expiresAt:invitation.expiresAt};
    }
    if(operation==='ack')return this.room.receipt(member,{eventId:id(input.eventId),sessionId:'human_'+member.id,state:'delivered',detail:'Person marked the message as read in the shared room',updatedAt:''});
    if(operation==='send'){
      const target=this.room.session(id(input.targetSessionId));
      assert(target.provider!=='human'&&target.state!=='closed',409,'Choose an open agent session');
      const text=bounded(input.text,8000),requestId=id(input.requestId);
      const self=this.human(member);
      const event=await this.room.append(member,{id:requestId,sessionId:self.id,targetSessionId:target.id,kind:input.replyTo?'reply':'question',text,paths:[],...(input.replyTo?{replyTo:id(input.replyTo),phase:'final' as const}:{})});
      return {event};
    }
    assert(operation==='read',400,'Unknown room operation');
    const cursor=(name:string)=>{const value=input[name];assert(value===undefined||(Number.isSafeInteger(value)&&Number(value)>=0),400,'Invalid history cursor');return value as number|undefined;};
    const before=cursor('before'),after=cursor('after');assert(before===undefined||after===undefined,400,'Use only one history cursor');
    const rows=this.sql.all<{seq:number;data:string}>(`SELECT seq,data FROM events ${after!==undefined?'WHERE seq>?':before!==undefined?'WHERE seq<?':''} ORDER BY seq ${after!==undefined?'ASC':'DESC'} LIMIT 51`,...(after!==undefined?[after]:before!==undefined?[before]:[]));
    const more=rows.length>50,events=rows.slice(0,50).map(r=>({...JSON.parse(r.data),seq:r.seq} as RelayEvent));
    if(after===undefined)events.reverse();
    const snapshot=this.room.snapshot();
    // Viewing group activity never acknowledges on behalf of another participant.
    const receiptRows=this.sql.all<{data:string}>("SELECT data FROM receipts ORDER BY json_extract(data,'$.updatedAt') DESC LIMIT 500");
    if(events.length)receiptRows.push(...this.sql.all<{data:string}>(`SELECT data FROM receipts WHERE event_id IN (${events.map(()=>'?').join(',')})`,...events.map(e=>e.id)));
    const receipts=[...new Map(receiptRows.map(r=>{const value=JSON.parse(r.data);return [value.eventId,value];})).values()];
    return {project:snapshot.project,member,members:snapshot.members,sessions:snapshot.sessions,events,receipts,more,cursor:events.at(-1)?.seq??after??0,oldest:events[0]?.seq??0,serverTime:new Date().toISOString()};
  }
}

export async function routeDashboard(dashboard:Dashboard,room:Room,request:Request):Promise<Response> {
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  try {
    const origin=request.headers.get('Origin');assert(!origin||origin===new URL(request.url).origin,403,'Origin not allowed');
    assert(request.method==='POST',405,'Use POST');
    assert(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'Use application/json');
    const member=await room.authenticate(request.headers.get('authorization')?.replace(/^Bearer /i,'')??'');
    const reader=request.body?.getReader();let text='',bytes=0;const decoder=new TextDecoder();
    if(reader)try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>40_000){await reader.cancel();throw new RelayError(413,'Request too large');}text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
    const input=JSON.parse(text);assert(input&&typeof input==='object'&&!Array.isArray(input),400,'Invalid request');
    return Response.json(await dashboard.call(member,input,new URL(request.url)),{headers:{...headers,...(['send','ack'].includes(input.operation)?{'X-Relay-Changed':'1'}:{})}});
  } catch(error){const status=error instanceof RelayError?error.status:error instanceof SyntaxError?400:500;return Response.json({error:status===500?'Relay could not complete the request':(error as Error).message},{status,headers});}
}
