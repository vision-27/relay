#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ClaudeChannel } from './claude-channel.js';
import { ClaudeSessions, sessionContext, validNativeId } from './claude-session.js';

export interface ClaudeHookInput {session_id:string;hook_event_name:string;prompt_id?:string;agent_id?:string;stop_hook_active?:boolean;source?:string}
export async function claudeSessionHook(store:ClaudeSessions,input:ClaudeHookInput,parentPid=process.ppid,signal?:AbortSignal):Promise<{code:number;text?:string}>{
  if(!validNativeId(input.session_id)||input.agent_id)return {code:0};
  const nativeId=input.session_id,event=input.hook_event_name;
  if(!['SessionStart','UserPromptSubmit','Stop','SessionEnd'].includes(event))return {code:0};
  if(event==='SessionEnd'){
    await store.locked(nativeId,()=>{const state=store.read(nativeId);if(state){state.mode='ended';delete state.listener;store.write(nativeId,state);}});return {code:0};
  }
  await store.ensure(nativeId);
  if(event==='Stop'){
    try{if(store.current(parentPid)!==nativeId)return {code:0};}catch{store.setCurrent(parentPid,nativeId);}
  }
  if(event!=='Stop')store.setCurrent(parentPid,nativeId);
  if(event==='UserPromptSubmit'){
    const state=await store.locked(nativeId,()=>{const state=store.read(nativeId)!;state.mode='busy';state.ownerPid=parentPid;state.promptId=input.prompt_id;delete state.listener;store.write(nativeId,state);return state;});
    return {code:0,text:JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:state.closed?'Relay is closed for this conversation. Call relay_open only if the user wants to reconnect.':sessionContext(state)}})};
  }
  const listener=randomUUID();
  const state=await store.locked(nativeId,()=>{
    const state=store.read(nativeId)!;
    if(state.closed||event==='Stop'&&input.prompt_id&&state.promptId&&input.prompt_id!==state.promptId)return;
    // A delayed startup hook must not overwrite a prompt that already started.
    if(event==='SessionStart'&&state.mode==='busy'&&state.ownerPid===parentPid&&state.promptId)return;
    state.mode='idle';state.ownerPid=parentPid;state.listener=listener;store.write(nativeId,state);return state;
  });
  if(!state)return {code:0};
  return new Promise(resolveResult=>{
    let finished=false,timer:ReturnType<typeof setInterval>;
    const finish=(code=0,text?:string)=>{if(finished)return;finished=true;clearInterval(timer);channel.stop();signal?.removeEventListener('abort',abort);resolveResult({code,text});};
    const abort=()=>finish();
    const channel=new ClaudeChannel(store.connection,event=>{
      const eventId=event.params?.meta?.event_id;if(!validNativeId(eventId))return;
      void store.locked(nativeId,()=>{
        const current=store.read(nativeId);
        if(finished||current?.listener!==listener||current.mode!=='idle'||store.current(parentPid)!==nativeId||current.supplied.includes(eventId))return;
        current.supplied.push(eventId);store.write(nativeId,current);
        // Only this reminder reaches Claude. Fetch peer content through the authenticated MCP tools.
        finish(2,`Relay has a pending message for this conversation. ${sessionContext(current)} Call relay_check now. If nothing is pending, do not send a reply.`);
      }).catch(()=>finish());
    },store.budget);
    timer=setInterval(()=>{
      try{const current=store.read(nativeId);process.kill(parentPid,0);if(channel.closed||current?.listener!==listener||current.mode!=='idle'||store.current(parentPid)!==nativeId)finish();}catch{finish();}
    },500);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){finish();return;}
    channel.watchSession(state.session_id,state.session_key);
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const connectionPath=process.argv[2];
  try{
    if(!connectionPath)throw Error('Relay connection missing');
    let data='';for await(const chunk of process.stdin){data+=chunk;if(Buffer.byteLength(data)>2_000_000)throw Error('Hook input too large');}
    const input=JSON.parse(data),store=new ClaudeSessions(JSON.parse(readFileSync(connectionPath,'utf8')),connectionPath);
    const result=await claudeSessionHook(store,input);
    if(result.text)(result.code===2?process.stderr:process.stdout).write(result.text+'\n');process.exitCode=result.code;
  }catch{process.stdout.write('{}\n');process.exitCode=0;}
}
