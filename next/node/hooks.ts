import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact, type Provider } from '../core/types.js';
import { context, INSTRUCTIONS } from './context.js';
import { snapshot, root } from './git.js';
import { State, loadConnection, stateDir, type Binding } from './state.js';
import { sharedWorkspace, workspaceCode, NETWORK_INSTRUCTIONS } from './network-state.js';
function lastAssistant(path:string):string {
  if(!path.endsWith('.jsonl'))return '';
  let fd:number|undefined;
  try {
    fd=openSync(path,'r');const size=fstatSync(fd).size,buffer=Buffer.alloc(Math.min(size,96_000));readSync(fd,buffer,0,buffer.length,Math.max(0,size-buffer.length));
    const lines=buffer.toString('utf8').split('\n');
    for(const line of lines.reverse())try {
      const record=JSON.parse(line);const m=record.message??record.payload;
      if(m?.role!=='assistant')continue;
      if(typeof m.content==='string')return m.content;
      if(Array.isArray(m.content))return m.content.filter((part:{type:string})=>['text','output_text'].includes(part.type)).map((part:{text?:string})=>part.text??'').join('\n');
    }catch{/* partial JSONL boundary */}
  }catch{/* transcript unavailable: no fabricated observation */}finally{if(fd!==undefined)closeSync(fd);}
  return '';
}
export function handleHook(repo:string,provider:Provider,input:Record<string,any>,env:NodeJS.ProcessEnv=process.env,directory?:string):Record<string,unknown> {
  const dir=directory??stateDir(repo),config=loadConnection(dir),network=config.mode==='network';
  if(input.agent_id||input.subagent_id)return {};
  if(!network)try{if(realpathSync(input.cwd??'')!==realpathSync(config.repo)&&root(input.cwd)!==realpathSync(config.repo))return {};}catch{return {};}
  if(typeof input.session_id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.session_id))return {};
  const state=new State(dir);state.set('repo',config.repo);
  try {
    state.set('mode',config.mode??'repository');
    const sessionId=`${provider}_${createHash('sha256').update(config.memberId+':'+input.session_id).digest('hex').slice(0,32)}`;
    const existing=state.bindings().find(s=>s.id===sessionId),now=Date.now(),event=String(input.hook_event_name??'');
    const workspace=network?sharedWorkspace(state,String(input.cwd??'')):config.repo;
    if(!workspace){if(network&&existing)state.bind({...existing,state:'closed',updatedAt:new Date(now).toISOString()});return {};}
    const updateGit=!existing || (network&&existing.workspace!==workspace) || ['SessionStart','UserPromptSubmit','Stop'].includes(event) || (event==='PostToolUse'&&now-(state.get<number>('gitAt')??0)>2000);
    const git=updateGit?(network?workspaceCode(workspace):snapshot(config.repo,config.repository)):existing.git;if(updateGit)state.set('gitAt',now);
    const binding:Binding={...existing,id:sessionId,memberId:config.memberId,provider,sourceId:input.session_id,
      name:existing?.name??`${config.name}/${provider}/${input.session_id.slice(0,6)}`,task:existing?.task??'',scopes:existing?.scopes??[],git,
      state:event==='SessionEnd'?'closed':event==='Stop'?'idle':event==='PermissionRequest'?'blocked':'active',
      updatedAt:new Date(now).toISOString(),hookSeenAt:now,...(network?{workspace,sessionKey:existing?.sessionKey??'relay_session_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','')}: {})};
    if(provider==='claude' && env.CLAUDE_CODE_MESSAGING_SOCKET && env.CLAUDE_CODE_MESSAGING_TOKEN){binding.endpoint=env.CLAUDE_CODE_MESSAGING_SOCKET;binding.inboxToken=env.CLAUDE_CODE_MESSAGING_TOKEN;}
    if(!network&&typeof input.transcript_path==='string')binding.transcriptPath=input.transcript_path;
    const surface=env.WMUX_SURFACE_ID??env.CMUX_SURFACE_ID;
    if(surface)binding.terminal={kind:env.WMUX_SURFACE_ID?'wmux':'cmux',surface,workspace:env.WMUX_WORKSPACE_ID??env.CMUX_WORKSPACE_ID,
      socket:env.WMUX_SURFACE_ID?(env.WMUX_PIPE??'\\\\.\\pipe\\wmux'):(env.CMUX_SOCKET_PATH??'/tmp/cmux.sock'),
      ...(env.WMUX_PIPE_TOKEN?{token:env.WMUX_PIPE_TOKEN}:{})};
    if(!network&&event==='UserPromptSubmit'&&typeof input.prompt==='string'&&!input.prompt.startsWith('Relay project message'))binding.task=redact(input.prompt.slice(0,600));
    state.bind(binding);
    if(event==='Stop'&&!network){
      const text=redact(String(input.last_assistant_message??(binding.transcriptPath?lastAssistant(binding.transcriptPath):'')).slice(0,3500));
      if(text.trim()){
        const eventId='obs_'+createHash('sha256').update(sessionId+text+git.fingerprint).digest('hex').slice(0,40);
        if(!state.get(`observed:${eventId}`)){
          state.publish({id:eventId,sessionId,kind:'observation',text,paths:git.files,evidence:`Observed final assistant text in ${provider} session ${binding.sourceId}. Claims have not been independently verified.`});
          state.set(`observed:${eventId}`,true);
        }
      }
    }
    if(['SessionEnd','PermissionRequest','Stop'].includes(event))return {};
    if(event==='SessionStart'){state.sql.exec("DELETE FROM supplied WHERE session_id=? AND NOT EXISTS (SELECT 1 FROM delivery WHERE delivery.event_id=supplied.event_id AND delivery.session_id=supplied.session_id AND delivery.state IN ('delivered','answered','answer_pending'))",sessionId);}
    const pack=context(state,sessionId,'',false);
    for(const item of pack.events)state.supply(sessionId,item.id);
    const briefing=event==='SessionStart'?`${network?NETWORK_INSTRUCTIONS:INSTRUCTIONS}\nYour relay session_id is ${sessionId}.${network?` Your local session_key is ${binding.sessionKey}; supply it to Relay Network tools and never share it.`:''} Use the ${network?'relay_network':'relay_next'} MCP. Connected ${network?'network':'project'}: ${config.repository}.\n`:'';
    const text=briefing+(pack.text?`Relay peer evidence (last successful sync ${pack.lastSync??'not yet connected'}):\n${pack.text}\n${pack.omitted?`${pack.omitted} additional records available through relay_context.\n`:''}`:'');
    if(!text)return {};
    state.measure('hook:'+event,text);
    return {hookSpecificOutput:{hookEventName:event,additionalContext:text}};
  }finally{state.close();}
}
