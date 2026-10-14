import { Room } from './room.js';
import { assert, id, RelayError, type Member, type Sql } from './types.js';

/** A delivery companion has membership access, never an agent's conversation key. */
export class Companion {
  constructor(private room:Room,private sql:Sql){
    sql.exec('CREATE TABLE IF NOT EXISTS companion_attempts (event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, attempt_id TEXT NOT NULL, state TEXT NOT NULL)');
  }
  call(member:Member,input:Record<string,unknown>){
    assert(this.room.project().mode==='network',403,'Companions require a Relay network');
    if(input.operation==='read'){
      return {sessions:this.sql.all<{session_id:string;source_id:string}>('SELECT session_id,source_id FROM mcp_hook_bindings WHERE member_id=?',member.id).flatMap(binding=>{
        const session=this.room.own(member,binding.session_id);
        if(session.provider!=='codex'||session.state==='closed'||session.state==='blocked')return [];
        const pending=this.sql.all<{id:string}>("SELECT e.id FROM events e LEFT JOIN receipts r ON r.event_id=e.id AND r.session_id=? LEFT JOIN companion_attempts a ON a.event_id=e.id WHERE json_extract(e.data,'$.targetSessionId')=? AND COALESCE(json_extract(r.data,'$.state'),'queued') NOT IN ('delivered','answered') AND a.event_id IS NULL ORDER BY e.seq LIMIT 20",session.id,session.id);
        return [{sessionId:session.id,nativeSessionId:binding.source_id,eventIds:pending.map(e=>e.id)}];
      })};
    }
    assert(input.operation==='claim'||input.operation==='finish',400,'Unknown companion operation');
    const session=this.room.own(member,id(input.sessionId)),event=this.room.event(id(input.eventId)),attemptId=id(input.attemptId);
    assert(session.provider==='codex'&&session.state!=='closed'&&session.state!=='blocked',409,'Session cannot receive native messages');
    assert(event.targetSessionId===session.id,403,'Message belongs to another conversation');
    const binding=this.sql.all<{source_id:string}>('SELECT source_id FROM mcp_hook_bindings WHERE session_id=? AND member_id=?',session.id,member.id)[0];
    assert(binding,409,'Resume this session once to attach its Relay hooks');
    if(input.operation==='claim')return this.sql.transaction(()=>{
      const row=this.sql.all<{data:string}>('SELECT data FROM receipts WHERE event_id=? AND session_id=?',event.id,session.id)[0];
      const receipt=row?JSON.parse(row.data):undefined;
      if(receipt&&['delivered','answered'].includes(receipt.state))return {claimed:false};
      if(this.sql.all('SELECT event_id FROM companion_attempts WHERE event_id=?',event.id).length)return {claimed:false};
      // Persist before invoking the native client. An ambiguous crash must not retry blindly.
      this.sql.exec('INSERT INTO companion_attempts VALUES (?,?,?,?)',event.id,session.id,attemptId,'attempting');
      this.room.receipt(member,{eventId:event.id,sessionId:session.id,state:'uncertain',detail:'Native handoff started; waiting for client confirmation. Hooks retain the message if the companion disconnects.',updatedAt:''});
      return {claimed:true,nativeSessionId:binding.source_id};
    });
    assert(input.state==='accepted'||input.state==='uncertain',400,'A companion cannot claim the agent read or answered');
    const attempt=this.sql.all<{attempt_id:string;state:string}>('SELECT attempt_id,state FROM companion_attempts WHERE event_id=? AND session_id=?',event.id,session.id)[0];
    assert(attempt?.attempt_id===attemptId,409,'Delivery attempt does not match');
    assert(attempt.state==='attempting'||attempt.state===input.state,409,'Delivery outcome already recorded');
    this.sql.exec('UPDATE companion_attempts SET state=? WHERE event_id=?',input.state,event.id);
    this.room.receipt(member,{eventId:event.id,sessionId:session.id,state:input.state,detail:input.state==='accepted'?'Codex accepted the follow-up; it runs now if idle or after its current turn':'Native delivery outcome unknown; automatic retry withheld. The message remains available through Relay hooks.',updatedAt:''});
    return {recorded:true};
  }
}

export async function routeCompanion(companion:Companion,room:Room,request:Request){
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  try{
    assert(!request.headers.has('Origin'),403,'Browser origins are not allowed');
    assert(request.method==='POST',405,'Use POST');
    assert(request.headers.get('content-type')?.split(';')[0]==='application/json',415,'Use application/json');
    const member=await room.authenticate(request.headers.get('authorization')?.replace(/^Bearer /i,'')??'');
    const reader=request.body?.getReader();let size=0,text='';const decoder=new TextDecoder();
    if(reader)try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>4000){await reader.cancel();throw new RelayError(413,'Request too large');}text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
    const input=JSON.parse(text);assert(input&&typeof input==='object'&&!Array.isArray(input),400,'Invalid request');
    return Response.json(companion.call(member,input),{headers:{...headers,...(input.operation==='finish'?{'X-Relay-Changed':'1'}:{})}});
  }catch(error){const status=error instanceof RelayError?error.status:error instanceof SyntaxError?400:500;return Response.json({error:status===500?'Companion request failed':(error as Error).message},{status,headers});}
}
