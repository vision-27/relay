import { State, loadConnection, publicSession } from './state.js';
import { Remote } from './client.js';
import { snapshot } from './git.js';
import { exportArtifact, receiveArtifact, readArtifact } from './artifacts.js';
import { prepare, validate } from './integration.js';
import { integer, compactCode } from './context.js';
const str={type:'string'},num={type:'integer'},bool={type:'boolean'},strings={type:'array',items:str};
const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]=[])=>({name,description,inputSchema:{type:'object',properties:{session_id:str,...properties},required:['session_id',...required],additionalProperties:false}});
export const advancedTools=[
  tool('relay_project','Read the local shared project view without waking peers. Source claims and freshness remain explicit.',{}),
  tool('relay_task','Reserve file scopes with an expiring lease. Refresh versions before renew/handoff/complete/release. Native edits outside Relay are not locked.',{operation:{type:'string',enum:['list','claim','renew','handoff','complete','release','block']},id:str,version:num,title:str,paths:strings,dependencies:strings,target_session_id:str,ttl_seconds:num,offset:num,limit:num},['operation']),
  tool('relay_artifact','Transfer exact selected file bytes, not source text in replies. Export requires local user sharing authorization. Read returns a bounded range; receiving never applies files.',{operation:{type:'string',enum:['list','export','receive','read','abort']},artifact_id:str,paths:strings,share:bool,allow_untracked:bool,base_ref:str,summary:str,target_session_id:str,path:str,offset:num,limit:num},['operation']),
  tool('relay_integration','Prepare an artifact in an isolated Git worktree or validate using an explicit local command. Accept is a separate developer-authorized CLI step.',{operation:{type:'string',enum:['prepare','validate']},artifact_id:str,id:str,command:strings,timeout_ms:num},['operation']),
  tool('relay_metrics','Read local payload sizes and operation counts. These are not provider tokens or billing.',{})
];
export async function callAdvanced(state:State,name:string,args:Record<string,any>){
  const session=state.binding(args.session_id),remote=new Remote(loadConnection(state.dir)),repo=state.get<string>('repo')!;
  if(name==='relay_metrics')return {counters:state.metrics(),unit:'characters and UTF-8 bytes; no model token or billing claim',providerUsage:'Not collected'};
  if(name==='relay_project'){
    const shared=state.get<any>('snapshot')??{};
    return {project:shared.project??{repository:session.git.repository},acceptedRevision:shared.acceptedRevision??null,lastSync:state.get('lastSync')??null,tasks:(shared.tasks??[]).filter((t:any)=>t.status!=='released'&&t.status!=='complete').slice(0,12).map((t:any)=>({...t,leaseExpired:t.expiresAt<=Date.now()})),decisions:state.decisions().slice(-8).reverse().map(e=>({id:e.id,kind:e.kind,text:e.text.slice(0,300),source:e.sessionId,at:e.createdAt,head:e.git.head,dirty:e.git.dirty})),coverage:'Up to 12 unfinished tasks and 8 current decisions; use context search for more. Recorded facts are not a fresh owner answer.'};
  }
  if(name==='relay_task'){
    if(args.operation==='list'){const saved=await remote.call<any>('tasks'),offset=integer(args.offset,0,0,10000),limit=integer(args.limit,10,1,25);return {tasks:saved.tasks.slice(offset,offset+limit),total:saved.tasks.length,nextOffset:offset+limit<saved.tasks.length?offset+limit:null,acceptedRevision:saved.acceptedRevision};}
    session.git=snapshot(repo,session.git.repository);state.bind(session);await remote.call('sessions',publicSession(session));
    return remote.call('tasks',{...args,sessionId:session.id,targetSessionId:args.target_session_id,ttlSeconds:args.ttl_seconds,baseHead:session.git.head});
  }
  if(name==='relay_artifact'){
    if(args.operation==='list'){const saved=await remote.call<any>('artifacts'),offset=integer(args.offset,0,0,10000),limit=integer(args.limit,10,1,25);return {artifacts:saved.artifacts.slice(offset,offset+limit).map((a:any)=>({...a,source:compactCode(a.source),paths:a.paths.slice(0,5),pathCount:a.paths.length})),total:saved.artifacts.length,nextOffset:offset+limit<saved.artifacts.length?offset+limit:null};}
    if(args.operation==='abort')return remote.call('artifacts',{operation:'abort',id:args.artifact_id,sessionId:session.id});
    if(args.operation==='export'){const result=await exportArtifact(state,args);return {...result,artifact:{...result.artifact,source:compactCode(result.artifact.source)}};}
    const {artifact,bundle}=await receiveArtifact(state,String(args.artifact_id));
    if(args.operation==='receive')return {artifact,files:bundle.files.map(f=>({path:f.path,before:f.before,after:f.after,bytes:f.data?Buffer.from(f.data,'base64').length:0})),applied:false};
    if(args.operation==='read')return readArtifact(bundle,String(args.path),integer(args.offset,0,0,2_000_000),integer(args.limit,2000,100,4000));
    throw new Error('Invalid artifact operation');
  }
  if(name==='relay_integration'){
    if(args.operation==='prepare')return prepare(state,String(args.artifact_id));
    if(args.operation==='validate')return validate(state,String(args.id),args.command,integer(args.timeout_ms,60000,1000,120000));
    throw new Error('Acceptance requires the separate local CLI operation');
  }
  throw new Error('Unknown workflow tool');
}
