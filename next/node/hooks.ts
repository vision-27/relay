import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { redact, type Provider } from '../core/types.js';
import { context, INSTRUCTIONS } from './context.js';
import { snapshot, root } from './git.js';
import { State, loadConnection, stateDir, type Binding } from './state.js';
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
export function handleHook(repo:string,provider:Provider,input:Record<string,any>,env:NodeJS.ProcessEnv=process.env):Record<string,unknown> {
  const dir=stateDir(repo),config=loadConnection(dir);
  if(input.agent_id||input.subagent_id)return {};
  try{if(realpathSync(input.cwd??'')!==realpathSync(config.repo)&&root(input.cwd)!==realpathSync(config.repo))return {};}catch{return {};}
  if(typeof input.session_id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.session_id))return {};
  const state=new State(dir);state.set('repo',config.repo);
  try {
    const sessionId=`${provider}_${createHash('sha256').update(config.memberId+':'+input.session_id).digest('hex').slice(0,32)}`;
    const existing=state.bindings().find(s=>s.id===sessionId),now=Date.now(),event=String(input.hook_event_name??'');
    const updateGit=!existing || ['SessionStart','UserPromptSubmit','Stop'].includes(event) || (event==='PostToolUse'&&now-(state.get<number>('gitAt')??0)>2000);
    const git=updateGit?snapshot(config.repo,config.repository):existing.git;if(updateGit)state.set('gitAt',now);
    const binding:Binding={...existing,id:sessionId,memberId:config.memberId,provider,sourceId:input.session_id,
      name:existing?.name??`${config.name}/${provider}/${input.session_id.slice(0,6)}`,task:existing?.task??'',scopes:existing?.scopes??[],git,
      state:event==='SessionEnd'?'closed':event==='Stop'?'idle':event==='PermissionRequest'?'blocked':'active',
      updatedAt:new Date(now).toISOString(),hookSeenAt:now};
    if(provider==='claude' && env.CLAUDE_CODE_MESSAGING_SOCKET && env.CLAUDE_CODE_MESSAGING_TOKEN){binding.endpoint=env.CLAUDE_CODE_MESSAGING_SOCKET;binding.inboxToken=env.CLAUDE_CODE_MESSAGING_TOKEN;}
    if(typeof input.transcript_path==='string')binding.transcriptPath=input.transcript_path;
    const surface=env.WMUX_SURFACE_ID??env.CMUX_SURFACE_ID;
    if(surface)binding.terminal={kind:env.WMUX_SURFACE_ID?'wmux':'cmux',surface,workspace:env.WMUX_WORKSPACE_ID??env.CMUX_WORKSPACE_ID,
      socket:env.WMUX_SURFACE_ID?(env.WMUX_PIPE??'\\\\.\\pipe\\wmux'):(env.CMUX_SOCKET_PATH??'/tmp/cmux.sock'),
      ...(env.WMUX_PIPE_TOKEN?{token:env.WMUX_PIPE_TOKEN}:{})};
    if(event==='UserPromptSubmit'&&typeof input.prompt==='string'&&!input.prompt.startsWith('Relay project message'))binding.task=redact(input.prompt.slice(0,600));
    state.bind(binding);
    if(event==='Stop'){
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
    const pack=context(state,sessionId,'',event==='SessionStart');
    for(const item of pack.events)state.supply(sessionId,item.id);
    const briefing=event==='SessionStart'?`${INSTRUCTIONS}\nYour relay session_id is ${sessionId}. Connected project: ${config.repository}.\n`:'';
    const text=briefing+(pack.text?`Relay peer evidence (last successful sync ${pack.lastSync??'not yet connected'}):\n${pack.text}\n${pack.omitted?`${pack.omitted} additional records available through relay_context.\n`:''}`:'');
    if(!text)return {};
    return {hookSpecificOutput:{hookEventName:event,additionalContext:text}};
  }finally{state.close();}
}
