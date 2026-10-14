import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { bounded, paths, redact, fresh, type EventInput, type Session, type RelayEvent } from '../core/types.js';
import { context, conflicts, INSTRUCTIONS, compactCode, eventPage, integer } from './context.js';
import { snapshot } from './git.js';
import { advancedTools, callAdvanced } from './workflow.js';
import { State, loadConnection } from './state.js';
import { Remote } from './client.js';
import { discover, NETWORK_INSTRUCTIONS, workspaceCode, sharedWorkspace } from './network-state.js';
import { VERSION } from '../core/version.js';
const string={type:'string'};
const definition=(name:string,description:string,properties:Record<string,unknown>,required:string[])=>({name,description,inputSchema:{type:'object',properties:{session_id:string,...properties},required:['session_id',...required],additionalProperties:false}});
export const TOOLS=[
  ...advancedTools,
  definition('relay_event','Read an exact event preview or next character range; does not wake another model.',{event_id:string,offset:{type:'integer'},limit:{type:'integer'}},['event_id']),
  definition('relay_status','See peer activity, last sync, actual delivery receipts and overlapping work. Paginated; receipts only on request.',{offset:{type:'integer'},limit:{type:'integer'},include_receipts:{type:'boolean'}},[]),
  definition('relay_context','Retrieve source-attributed decisions and history relevant to the current work. Code presence is reported separately.',{query:string,max_chars:{type:'integer'}},[]),
  definition('relay_publish','Publish meaningful engineering intent, decisions, contracts or test evidence. Include why; never publish secrets.',{kind:{type:'string',enum:['intent','decision','contract','test']},text:string,paths:{type:'array',items:string},evidence:string,supersedes:string,urgent:{type:'boolean'}},['kind','text','paths']),
  definition('relay_ask','Ask an exact peer session. Returns a request ID immediately; the answer arrives asynchronously.',{target_session_id:string,question:string,paths:{type:'array',items:string}},['target_session_id','question']),
  definition('relay_reply','Answer a question addressed to this session using retained source knowledge; state uncertainties.',{question_id:string,answer:string,evidence:string,phase:{type:'string',enum:['progress','final']}},['question_id','answer']),
  definition('relay_ack','Acknowledge a direct message that was actually supplied to this session. This is receipt, not approval.',{event_id:string,event_ids:{type:'array',items:string}},[])
];
const NETWORK_NAMES=new Set(['relay_invite','relay_discover','relay_presence','relay_event','relay_status','relay_context','relay_ask','relay_reply','relay_ack']);
export const NETWORK_TOOLS=[
  definition('relay_invite','Create a single-use invitation when the user asks to add a friend. Owner/admin only. Return it to the user; never send it to peers automatically. The invite grants group membership, including access to shared network records.',{},[]),
  definition('relay_discover','Find invited peers across workspaces by person and task/topic. Multiple matches require a session choice.',{person:string,topic:string,active_only:{type:'boolean'},offset:{type:'integer'},limit:{type:'integer'}},[]),
  definition('relay_presence','Share a brief, non-sensitive description of the current task. No prompt/transcript upload.',{task:string},['task']),
  ...TOOLS.filter(t=>NETWORK_NAMES.has(t.name))
].map(tool=>({...tool,inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,session_key:string},required:[...tool.inputSchema.required,'session_key']}}));
export function callTool(state:State,name:string,args:Record<string,any>):unknown {
  const binding=state.binding(String(args.session_id)),sessionId=binding.id;
  const network=state.get('mode')==='network';
  if(network&&!NETWORK_NAMES.has(name))throw new Error('This tool requires a repository connection');
  if(network&&(!binding.sessionKey||args.session_key!==binding.sessionKey))throw new Error('Use the session_id and local session_key supplied by this session\'s Relay Network hook');
  if(network&&(!binding.workspace||!sharedWorkspace(state,binding.workspace)||binding.state==='closed'))throw new Error('This session is no longer shared; resume it in an allowed workspace');
  if(name==='relay_invite'){
    if(!network)throw new Error('Inviting a friend requires a network connection');
    const config=loadConnection(state.dir);
    return new Remote(config).call<{code:string;expiresAt:number}>('invite',{}).then(invite=>({
      invitation:'relay:network:v1:'+Buffer.from(JSON.stringify({server:config.server,projectId:config.projectId,repository:config.repository,code:invite.code})).toString('base64url'),
      expiresAt:new Date(invite.expiresAt).toISOString(),singleUse:true,
      instructions:'Give this invitation to your friend. They run Relay setup and paste it when asked. All network members can access shared network records.'
    }));
  }
  if(name==='relay_discover')return discover(state,sessionId,args);
  if(name==='relay_presence'){
    binding.task=redact(bounded(args.task,1000));binding.updatedAt=new Date().toISOString();state.bind(binding);return {sessionId,task:binding.task,status:'pending_sync'};
  }
  if(name==='relay_status'){
    const saved=state.get<{sessions:Session[];receipts:unknown[]}>('snapshot');
    const sessions=saved?.sessions??[];
    const offset=integer(args.offset,0,0,10000),limit=integer(args.limit,8,1,20);
    return {sessions:sessions.slice(offset,offset+limit).map(s=>({id:s.id,name:s.name,provider:s.provider,state:s.state,task:s.task.slice(0,300),updatedAt:s.updatedAt,freshActivity:fresh(s),git:compactCode(s.git),scopes:s.scopes.slice(0,8)})),nextOffset:offset+limit<sessions.length?offset+limit:null,totalSessions:sessions.length,receipts:args.include_receipts?saved?.receipts?.slice(offset,offset+limit)??[]:[],overlaps:conflicts(sessions).slice(0,8),lastSync:state.get('lastSync')??null,syncError:state.get('syncError')??null,pendingUploads:state.pending().length,rejectedUploads:state.sql.all<{value:string}>("SELECT value FROM kv WHERE key LIKE 'rejected:%' LIMIT 8").map(r=>JSON.parse(r.value))};
  }
  if(name==='relay_event'){
    const event=state.event(String(args.event_id));if(!event)throw new Error('Event not in local cache; wait for synchronization');
    if(network&&event.sessionId!==sessionId&&event.targetSessionId!==sessionId)throw new Error('This message belongs to another conversation');
    state.supply(sessionId,event.id);return eventPage(event,integer(args.offset,0,0,11000),integer(args.limit,2000,100,4000));
  }
  if(name==='relay_context'){
    const budget=integer(args.max_chars,5000,1500,12000),pack=context(state,sessionId,String(args.query??''),true,budget-700);
    const result={expand:'relay_event(event_id, offset) for full evidence',text:pack.text,eventIds:pack.events.map(e=>e.id),omitted:pack.omitted,cursor:pack.cursor,lastSync:pack.lastSync,coverage:pack.coverage};
    // Bound the serialized response, not only the readable body.
    while(JSON.stringify(result).length>budget&&result.text.length){result.text=result.text.slice(0,-100);}
    for(const event of pack.events)state.supply(sessionId,event.id);
    return result;
  }
  if(name==='relay_ack'){
    const ids=args.event_ids??[args.event_id];if(!Array.isArray(ids)||!ids.length||ids.length>50)throw new Error('Supply 1..50 event IDs');
    const events=ids.map(id=>state.event(String(id)));
    if(events.some(event=>!event||event.targetSessionId!==sessionId))throw new Error('This message is not addressed to this session');
    state.sql.transaction(()=>{for(const event of events){state.supply(sessionId,event!.id);state.mark(event!.id,sessionId,'delivered','Recipient acknowledged receipt');state.enqueue('receipts',{eventId:event!.id,sessionId,state:'delivered',detail:'Recipient acknowledged receipt'},`receipt:${event!.id}:${sessionId}`);}});
    return {received:true,eventIds:ids};
  }
  const repo=binding.workspace??state.get<string>('repo');if(!repo)throw new Error('Missing connected repository');
  binding.git=network?workspaceCode(repo):snapshot(repo,binding.git.repository);binding.updatedAt=new Date().toISOString();
  const event:EventInput={id:crypto.randomUUID(),sessionId,kind:'decision',text:'',paths:paths(args.paths??[])};
  if(name==='relay_publish'){
    if(!['intent','decision','contract','test'].includes(args.kind))throw new Error('Invalid publication kind');
    event.kind=args.kind;event.text=redact(bounded(args.text,8000));
    if(args.evidence)event.evidence=redact(bounded(args.evidence,3000));
    if(args.supersedes)event.supersedes=args.supersedes;
    event.urgent=args.urgent===true;
    if(event.kind==='intent'){binding.task=event.text.slice(0,1000);binding.scopes=event.paths;}
  }else if(name==='relay_ask'){
    const target=state.get<{sessions:Session[]}>('snapshot')?.sessions.find(s=>s.id===args.target_session_id);
    if(!target||target.id===sessionId)throw new Error('Choose a peer session ID from relay_status');
    event.kind='question';event.targetSessionId=target.id;event.text=redact(bounded(args.question,8000));
  }else if(name==='relay_reply'){
    const question=state.event(args.question_id);
    if(question?.kind!=='question'||question.targetSessionId!==sessionId)throw new Error('Question was not addressed to this session');
    event.kind='reply';event.replyTo=question.id;event.targetSessionId=question.sessionId;event.text=redact(bounded(args.answer,8000));
    if(args.evidence)event.evidence=redact(bounded(args.evidence,3000));
    if(args.phase!==undefined&&!['progress','final'].includes(args.phase))throw new Error('Invalid reply phase');
    event.phase=args.phase??'final';
    if(event.phase==='final'){
      event.id='answer_'+createHash('sha256').update(sessionId+question.id).digest('hex').slice(0,40);
      const previous=state.get<EventInput>('answer:'+event.id)??state.event(event.id)??state.pending().map(j=>j.body as EventInput).find(e=>e.id===event.id);
      if(previous){if(previous.text!==event.text||previous.evidence!==event.evidence)throw new Error('Final answer already recorded; use progress for an explicit correction/update');return {eventId:event.id,status:'already_recorded'};}
    }
    state.supply(sessionId,question.id);state.mark(question.id,sessionId,event.phase==='final'?'answer_pending':'delivered','Reply in durable local outbox');
  }else throw new Error('Unknown Relay tool');
  return state.sql.transaction(()=>{state.bind(binding);const result=state.publish(event);if(event.kind==='reply'&&event.phase==='final')state.set('answer:'+event.id,event);return result;});
}
export async function callRelayTool(state:State,name:string,args:Record<string,any>):Promise<unknown>{
  if(state.get('mode')==='network'&&!NETWORK_NAMES.has(name))throw new Error('This tool requires a repository connection');
  const result=advancedTools.some(t=>t.name===name)?await callAdvanced(state,name,args):await callTool(state,name,args);
  state.measure('tool:'+name,JSON.stringify(result));return result;
}
export async function serveMcp(state:State,input:Readable=process.stdin,output:Writable=process.stdout) {
  const lines=createInterface({input,crlfDelay:Infinity});
  for await(const line of lines){
    if(line.length>100_000)continue;
    let request:any;try{request=JSON.parse(line);}catch{output.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');continue;}
    if(request.id===undefined)continue;
    let result:unknown;
    try {
      if(request.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:state.get('mode')==='network'?'relay-network':'relay-next',version:VERSION},instructions:state.get('mode')==='network'?NETWORK_INSTRUCTIONS:INSTRUCTIONS};
      else if(request.method==='ping')result={};
      else if(request.method==='tools/list')result={tools:state.get('mode')==='network'?NETWORK_TOOLS:TOOLS};
      else if(request.method==='tools/call'){
        try {result={content:[{type:'text',text:JSON.stringify(await callRelayTool(state,request.params.name,request.params.arguments??{}))}]};}
        catch(error){result={isError:true,content:[{type:'text',text:(error as Error).message}]};}
      }else {output.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');continue;}
      output.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    }catch{output.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'Relay request failed'}})+'\n');}
  }
}
