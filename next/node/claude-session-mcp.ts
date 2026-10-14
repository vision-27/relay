#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClaudeSessions, sessionContext, validNativeId } from './claude-session.js';

/** Stateless transport; the current conversation comes from native lifecycle hooks, never cwd. */
export class ClaudeSessionMcp {
  constructor(private store:ClaudeSessions,private parentPid=process.ppid,private initialId=process.env.CLAUDE_CODE_SESSION_ID){
    // Reset a stale PID mapping when a new MCP process starts; /clear is then updated by hooks.
    if(validNativeId(initialId))store.setCurrent(parentPid,initialId);
  }
  async handle(input:any){
    if(input.method==='tools/call'){
      const nativeId=this.store.current(this.parentPid,this.initialId),name=input.params?.name,args=input.params?.arguments??{};
      if(name==='relay_hook')throw Error('Codex hook tools do not belong to this Claude conversation');
      if(name==='relay_open'&&args.provider!=='claude')throw Error('This is a Claude conversation');
      if(args.native_session_id&&args.native_session_id!==nativeId)throw Error('Use this native conversation identity');
      const state=await this.store.ensure(nativeId,name==='relay_open');
      if(state.closed)throw Error('Relay is closed for this conversation');
      if(name==='relay_open'){
        const checked=await this.store.rpc({jsonrpc:'2.0',id:input.id,method:'tools/call',params:{name:'relay_check',arguments:{session_key:state.session_key,...(args.task!==undefined?{task:args.task}:{})}}});
        if(checked?.error||checked?.result?.isError)return checked;
        const data=JSON.parse(checked.result.content.find((item:any)=>item.type==='text').text);
        // The check supplied pending messages: preserve them in the model's response.
        return {jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:JSON.stringify({session_id:state.session_id,session_key:state.session_key,instructions:sessionContext(state),inbox:data.inbox})}]}};
      }
      if(args.session_key!==state.session_key)throw Error('Use this conversation\'s own Relay key');
      const response=await this.store.rpc(input);
      if(name==='relay_close'&&!response?.error&&!response?.result?.isError)await this.store.locked(nativeId,()=>{const current=this.store.read(nativeId)!;current.closed=true;current.mode='ended';delete current.listener;this.store.write(nativeId,current);});
      return response;
    }
    const response=await this.store.rpc(input);
    if(input.method==='initialize'&&response?.result){
      response.result.instructions='Relay attaches through native conversation hooks across all workspaces. Follow the private session context supplied by Relay; never create a second session or use another conversation key. '+response.result.instructions;
    }
    return response;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const path=process.argv[2];if(!path)throw Error('Pass a private Relay connection file');
  const proxy=new ClaudeSessionMcp(new ClaudeSessions(JSON.parse(readFileSync(path,'utf8')),path));
  const lines=createInterface({input:process.stdin});
  lines.on('line',async line=>{let input:any;try{if(Buffer.byteLength(line)>40000)throw Error('MCP request too large');input=JSON.parse(line);const result=await proxy.handle(input);if(result)process.stdout.write(JSON.stringify(result)+'\n');}catch{if(input?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,error:{code:-32603,message:'Relay could not attach this conversation. Check Relay setup and its session hooks.'}})+'\n');}});
}
