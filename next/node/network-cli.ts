import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, realpathSync, linkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import type { Provider } from '../core/types.js';
import { loadConnection, saveConnection, State, type Connection } from './state.js';
import { api, Remote, serverURL } from './client.js';
import { Connector } from './connector.js';
import { nativeDelivery } from './adapters.js';
import { handleHook } from './hooks.js';
import { callRelayTool, serveMcp } from './tools.js';
import { applyNetworkInstall, planNetworkInstall } from './network-install.js';
import { networkDir, sharedWorkspace, type Sharing } from './network-state.js';
import { VERSION } from '../core/version.js';
import { runtimeNode } from './network-runtime.js';

type Options=Record<string,string|boolean|undefined>;
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
function connectorRunning(dir:string) {
  try {const lock=JSON.parse(readFileSync(join(dir,'connector.lock'),'utf8'));return typeof lock.pid==='number'&&alive(lock.pid);}catch{return false;}
}
export async function startNetwork(dir:string,cli:string,explicit=false) {
  const stop=join(dir,'stop');
  if(existsSync(stop)){if(!explicit)return;unlinkSync(stop);}
  if(connectorRunning(dir)){
    const current=JSON.parse(readFileSync(join(dir,'connector.lock'),'utf8'));
    if(current.version===VERSION&&current.cli===cli)return;
    writeFileSync(stop,'upgrade');
    for(let i=0;i<50&&connectorRunning(dir);i++)await new Promise(r=>setTimeout(r,100));
    if(connectorRunning(dir))throw new Error('Network connector has not stopped for upgrade; retry after it exits');
    if(existsSync(stop))unlinkSync(stop);
  }
  const fd=openSync(join(dir,'connector.log'),'a',0o600);
  try {
    const child=spawn(runtimeNode(cli),[cli,'run','--global','--dir',dir],{cwd:dir,windowsHide:true,detached:true,stdio:['ignore',fd,fd],env:{...process.env,RELAY_CREATE_KEY:undefined}});
    child.on('error',error=>console.error(`Relay Network could not start: ${error.message}`));child.unref();
  }finally{closeSync(fd);}
}
export async function runNetwork(dir:string,cli:string) {
  const config=loadConnection(dir);if(config.mode!=='network')throw new Error('This is not a network connection');
  const lock=join(dir,'connector.lock');
  if(existsSync(lock)){if(connectorRunning(dir))throw new Error('Relay Network connector is already running');unlinkSync(lock);}
  // Publish a complete record atomically, while retaining exclusive acquisition.
  // Opening the public lock with wx first briefly exposed an empty file to other sessions.
  const pending=join(dir,`connector-${crypto.randomUUID()}.pending`);
  writeFileSync(pending,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),version:VERSION,cli}),{flag:'wx',mode:0o600});
  try{linkSync(pending,lock);}finally{unlinkSync(pending);}
  const state=new State(dir);state.set('mode','network');
  const connector=new Connector(state,new Remote(config),nativeDelivery(dir));
  try {
    connector.start();
    await new Promise<void>(done=>{
      const stop=()=>{clearInterval(timer);process.off('SIGINT',stop);process.off('SIGTERM',stop);done();};
      const timer=setInterval(()=>{if(existsSync(join(dir,'stop')))stop();},500);
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
    });
  }finally{await connector.stop();state.close();unlinkSync(lock);}
}
export function changeSharing(state:State,workspace:string|undefined,all:boolean,share:boolean) {
  const previous=state.get<Sharing>('sharing')??{all:false,roots:[]};
  let policy:Sharing;
  if(all)policy={all:share,roots:[],excluded:[]};
  else {
    if(!workspace)throw new Error('Choose --repo PATH or --all-workspaces');
    const path=realpathSync(workspace);
    policy={...previous,roots:share?[...new Set([...previous.roots,path])]:previous.roots.filter(r=>r!==path),excluded:share?(previous.excluded??[]).filter(r=>r!==path):[...new Set([...(previous.excluded??[]),path])]};
  }
  state.set('sharing',policy);
  for(const binding of state.bindings())if(binding.workspace&&!sharedWorkspace(state,binding.workspace))state.bind({...binding,state:'closed',updatedAt:new Date().toISOString()});
  return policy;
}
export async function networkMain(cmd:string,values:Options,cli:string) {
  const option=(name:string)=>typeof values[name]==='string'?values[name] as string:undefined;
  const dir=resolve(option('dir')??networkDir());
  if(cmd==='hook'){
    let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>1_000_000)throw new Error('Hook input too large');}
    try {
      const input=JSON.parse(data);
      const provider=option('provider');if(provider!=='codex'&&provider!=='claude')throw new Error('Unknown provider');
      const result=handleHook(String(input.cwd??process.cwd()),provider,input,process.env,dir);
      if(input.hook_event_name==='SessionStart')try{await startNetwork(dir,cli);}catch(error){console.error(`Relay Network connector unavailable: ${(error as Error).message}`);}
      console.log(JSON.stringify(result));
    }catch(error){console.error(`Relay Network hook unavailable: ${(error as Error).message}`);console.log('{}');}
    return;
  }
  if(cmd==='connect'){
    const provider=option('provider')??'both';if(!['codex','claude','both'].includes(provider))throw new Error('Provider must be codex, claude or both');
    const plans=values['no-install']?[]:(provider==='both'?['codex','claude']:[provider]).map(p=>planNetworkInstall(p as Provider,cli,dir,undefined,runtimeNode(cli)));
    let config:Connection;
    if(existsSync(join(dir,'connection.json'))){
      if(option('invite')||option('server'))throw new Error('A network is already connected. Re-run without --server/--invite to update the installation.');
      config=loadConnection(dir);if(config.mode!=='network')throw new Error('Directory belongs to a repository connection');
    }else {
      const name=option('name')??hostname();let projectId:string=crypto.randomUUID(),server:string,identity='relay-network';
      let credentials:{token:string;memberId:string};
      if(option('invite')){
        const encoded=option('invite')!;if(!encoded.startsWith('relay:network:v1:'))throw new Error('Use a Relay Network invitation, not a repository invitation');
        const invitation=JSON.parse(Buffer.from(encoded.slice('relay:network:v1:'.length),'base64url').toString('utf8'));
        server=serverURL(invitation.server);projectId=invitation.projectId;identity=invitation.repository;
        const joined=await api<{token:string;memberId:string;project:{mode?:string}}>(server,projectId,'','join',{code:invitation.code,name,repository:identity});
        if(joined.project?.mode!=='network')throw new Error('The service does not support this network. Upgrade Relay first.');
        credentials={token:joined.token,memberId:joined.memberId};
      }else {
        const url=option('server')??process.env.RELAY_SERVER_URL;if(!url)throw new Error('Supply --server HTTPS_URL or --invite CODE');
        const key=option('create-key')??process.env.RELAY_CREATE_KEY;if(!key)throw new Error('Network creation requires RELAY_CREATE_KEY; friends join using --invite');
        server=serverURL(url);identity='network:'+projectId;
        credentials=await api(server,projectId,key,'create',{name:`${name}'s network`.slice(0,80),ownerName:name,repository:identity,mode:'network'});
        const info=await api<{project:{mode?:string}}>(server,projectId,credentials.token,'snapshot');
        if(info.project.mode!=='network')throw new Error('The service does not support networks. Upgrade Relay first.');
      }
      config={...credentials,server,projectId,repository:identity,name,repo:dir,mode:'network'};saveConnection(dir,config);
    }
    const state=new State(dir);try{
      state.set('mode','network');
      if(values['all-workspaces'])changeSharing(state,undefined,true,true);
      else if(option('repo'))changeSharing(state,option('repo'),false,true);
      else if(!state.get('sharing'))changeSharing(state,undefined,true,true);
    }finally{state.close();}
    for(const plan of plans)applyNetworkInstall(plan,dir);
    if(!values['no-start'])await startNetwork(dir,cli,true);
    if(!values.quiet)console.log(`Relay Network connected for ${config.name}. Resume your coding clients once and review their MCP/hooks.\nYour agent sessions register automatically. Use relay-next invite --global to add a friend.`);return;
  }
  const config=loadConnection(dir);if(config.mode!=='network')throw new Error('This is not a network connection');
  if(cmd==='run'){if(existsSync(join(dir,'stop')))unlinkSync(join(dir,'stop'));await runNetwork(dir,cli);return;}
  if(cmd==='stop'){writeFileSync(join(dir,'stop'),'stop');console.log('Relay Network stopped until connect --global or run --global resumes it.');return;}
  if(cmd==='budget-refresh'){console.log(JSON.stringify(await new Remote(config).refreshBudget(),null,2));return;}
  if(cmd==='invite'){
    const invitation=await new Remote(config).call<{code:string;expiresAt:number}>('invite',{});
    const code='relay:network:v1:'+Buffer.from(JSON.stringify({server:config.server,projectId:config.projectId,repository:config.repository,code:invitation.code})).toString('base64url');
    console.log(`Single-use network invitation; expires ${new Date(invitation.expiresAt).toISOString()}:\n${code}\n\nFriend: relay setup --invite ${code}`);return;
  }
  if(cmd==='members'){console.log(JSON.stringify((await new Remote(config).call<{members:unknown[]}>('snapshot')).members,null,2));return;}
  if(cmd==='revoke'){
    if(!option('member'))throw new Error('Supply --member ID');
    console.log(JSON.stringify(await new Remote(config).call('revoke',{memberId:option('member')})));return;
  }
  const state=new State(dir);state.set('mode','network');
  try {
    if(cmd==='share'||cmd==='unshare'){
      console.log(JSON.stringify(changeSharing(state,option('repo'),values['all-workspaces']===true,cmd==='share'),null,2));
      await startNetwork(dir,cli);return;
    }
    if(cmd==='mcp'){await startNetwork(dir,cli);await serveMcp(state);return;}
    if(cmd==='doctor'||cmd==='status'){
      console.log(JSON.stringify({mode:'network',name:config.name,connectorRunning:connectorRunning(dir),paused:existsSync(join(dir,'stop')),sharing:state.get('sharing'),localSessions:state.bindings().map(b=>({id:b.id,provider:b.provider,state:b.state,task:b.task})),lastSync:state.get('lastSync')??null,syncError:state.get('syncError')??null,snapshot:state.get('snapshot')??null,pendingUploads:state.pending().length},null,2));return;
    }
    const sessionId=option('session')??option('from');if(!sessionId)throw new Error('Supply --session ID from relay-next status --global');
    const tool=({discover:'relay_discover',context:'relay_context',ask:'relay_ask',reply:'relay_reply',presence:'relay_presence'} as Record<string,string>)[cmd];
    if(!tool)throw new Error('Unknown network command; use connect, invite, members, revoke, share, unshare, status, doctor, run, stop, discover, context, ask, reply or presence');
    const args={...(option('args')?JSON.parse(option('args')!):{}),session_id:sessionId,...(cmd==='discover'?{...(option('name')?{person:option('name')}:{}),...(option('query')?{topic:option('query')}:{})}:{}),...(cmd==='context'&&option('query')?{query:option('query')}:{}),...(cmd==='ask'?{target_session_id:option('to'),question:option('message')}:{}),...(cmd==='presence'&&option('message')?{task:option('message')}:{}),...(cmd==='reply'?{question_id:option('id'),answer:option('message')}:{})};
    console.log(JSON.stringify(await callRelayTool(state,tool,{...args,session_key:state.binding(sessionId).sessionKey}),null,2));await startNetwork(dir,cli);
  }finally{state.close();}
}
