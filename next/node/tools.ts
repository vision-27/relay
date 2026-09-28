import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { bounded, paths, redact, fresh, type EventInput, type Session, type RelayEvent } from '../core/types.js';
import { context, conflicts, INSTRUCTIONS } from './context.js';
import { snapshot } from './git.js';
import { State } from './state.js';
const string={type:'string'};
const definition=(name:string,description:string,properties:Record<string,unknown>,required:string[])=>({name,description,inputSchema:{type:'object',properties:{session_id:string,...properties},required:['session_id',...required],additionalProperties:false}});
export const TOOLS=[
  definition('relay_status','See peer activity, last sync, actual delivery receipts and overlapping work.',{},[]),
  definition('relay_context','Retrieve source-attributed decisions and history relevant to the current work. Code presence is reported separately.',{query:string},[]),
  definition('relay_publish','Publish meaningful engineering intent, decisions, contracts or test evidence. Include why; never publish secrets.',{kind:{type:'string',enum:['intent','decision','contract','test']},text:string,paths:{type:'array',items:string},evidence:string,supersedes:string,urgent:{type:'boolean'}},['kind','text','paths']),
  definition('relay_ask','Ask an exact peer session. Returns a request ID immediately; the answer arrives asynchronously.',{target_session_id:string,question:string,paths:{type:'array',items:string}},['target_session_id','question']),
  definition('relay_reply','Answer a question addressed to this session using retained source knowledge; state uncertainties.',{question_id:string,answer:string,evidence:string},['question_id','answer']),
  definition('relay_ack','Acknowledge a direct message that was actually supplied to this session. This is receipt, not approval.',{event_id:string},['event_id'])
];
export function callTool(state:State,name:string,args:Record<string,any>):unknown {
  const binding=state.binding(String(args.session_id)),sessionId=binding.id;
  if(name==='relay_status'){
    const saved=state.get<{sessions:Session[];receipts:unknown[]}>('snapshot');
    const sessions=saved?.sessions??[];
    return {sessions:sessions.map(s=>({...s,freshActivity:fresh(s)})),receipts:saved?.receipts??[],overlaps:conflicts(sessions),lastSync:state.get('lastSync')??null,syncError:state.get('syncError')??null,pendingUploads:state.pending().length,rejectedUploads:state.sql.all<{value:string}>("SELECT value FROM kv WHERE key LIKE 'rejected:%' LIMIT 50").map(r=>JSON.parse(r.value))};
  }
  if(name==='relay_context'){
    const pack=context(state,sessionId,String(args.query??''),true);for(const event of pack.events)state.supply(sessionId,event.id);return pack;
  }
  if(name==='relay_ack'){
    const event=state.event(args.event_id);
    if(!event||event.targetSessionId!==sessionId)throw new Error('This message is not addressed to this session');
    state.mark(event.id,sessionId,'delivered','Recipient explicitly acknowledged the supplied message');
    state.enqueue('receipts',{eventId:event.id,sessionId,state:'delivered',detail:'Recipient explicitly acknowledged the supplied message'},`receipt:${event.id}:${sessionId}`);
    return {received:true,eventId:event.id};
  }
  const repo=state.get<string>('repo');if(!repo)throw new Error('Missing connected repository');
  binding.git=snapshot(repo,binding.git.repository);binding.updatedAt=new Date().toISOString();
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
  }else throw new Error('Unknown Relay tool');
  state.bind(binding);return state.publish(event);
}
export async function serveMcp(state:State,input:Readable=process.stdin,output:Writable=process.stdout) {
  const lines=createInterface({input,crlfDelay:Infinity});
  for await(const line of lines){
    if(line.length>100_000)continue;
    let request:any;try{request=JSON.parse(line);}catch{output.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');continue;}
    if(request.id===undefined)continue;
    let result:unknown;
    try {
      if(request.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'relay-next',version:'0.7.0-alpha.1'},instructions:INSTRUCTIONS};
      else if(request.method==='ping')result={};
      else if(request.method==='tools/list')result={tools:TOOLS};
      else if(request.method==='tools/call'){
        try {result={content:[{type:'text',text:JSON.stringify(callTool(state,request.params.name,request.params.arguments??{}))}]};}
        catch(error){result={isError:true,content:[{type:'text',text:(error as Error).message}]};}
      }else {output.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');continue;}
      output.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    }catch{output.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'Relay request failed'}})+'\n');}
  }
}
