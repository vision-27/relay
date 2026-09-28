#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { secret, type Provider } from '../core/types.js';
import { root, snapshot } from './git.js';
import { loadConnection, saveConnection, stateDir, State, type Connection } from './state.js';
import { api, Remote, serverURL } from './client.js';
import { install } from './install.js';
import { handleHook } from './hooks.js';
import { serveMcp, callTool } from './tools.js';
import { Connector } from './connector.js';
import { nativeDelivery, command } from './adapters.js';
import { startHub } from './hub.js';
const cli=fileURLToPath(import.meta.url);
const parsed=parseArgs({allowPositionals:true,options:Object.fromEntries([
  'repo','server','invite','name','provider','repository','session','from','to','message','query','dir','port','create-key'
].map(name=>[name,{type:'string' as const}]).concat([['json',{type:'boolean'}],['no-install',{type:'boolean'}],['no-start',{type:'boolean'}],['help',{type:'boolean'}],['relay-hook-v1',{type:'boolean'}]] as any))});
const values=parsed.values as Record<string,string|boolean|undefined>,positionals=parsed.positionals;
const option=(name:string)=>typeof values[name]==='string'?values[name] as string:undefined;
const help=`Relay Next — shared context for your existing coding sessions

  connect                 Connect a Git repository; install its agent integration
  connect --invite CODE   Join your teammate's project
  invite                  Create a single-use project invitation (24 hours)
  status                  Show sessions, freshness, pending uploads and receipts
  context --session ID    Inspect shared context and its code references
  ask --from ID --to ID --message TEXT
  run                     Run this repository's connector in the foreground
  stop                    Stop only this repository's Relay connector
  doctor                  Check local prerequisites and connection state
  dev --port 7337         Start a local-only service for development

Connection options: --repo PATH --server HTTPS_URL --provider codex|claude|both
                    --name NAME --repository SHARED_ID --no-start --no-install
Creating a hosted project requires RELAY_CREATE_KEY from the service operator.
Use npm run demo for an isolated two-connector demonstration.
`;
async function prompt(question:string,fallback?:string){
  if(!process.stdin.isTTY){if(fallback!==undefined)return fallback;throw new Error(`${question} Supply the corresponding command option in non-interactive mode.`);}
  const reader=createInterface({input:process.stdin,output:process.stdout});try{return (await reader.question(`${question}${fallback?` [${fallback}]`:''}: `)).trim()||fallback||'';}finally{reader.close();}
}
function startDaemon(repo:string){
  const dir=stateDir(repo),lock=join(dir,'connector.lock');
  if(existsSync(lock))try{process.kill(JSON.parse(readFileSync(lock,'utf8')).pid,0);return;}catch{/* stale lock is handled by run */}
  if(existsSync(join(dir,'stop')))unlinkSync(join(dir,'stop'));
  const fd=openSync(join(dir,'connector.log'),'a',0o600);
  const child=spawn(process.execPath,[cli,'run','--repo',repo],{cwd:repo,windowsHide:true,detached:true,stdio:['ignore',fd,fd],env:{...process.env,RELAY_CREATE_KEY:undefined}});
  child.unref();closeSync(fd);
}
async function connectProject(repo:string){
  const dir=stateDir(repo);let config:Connection;
  if(existsSync(join(dir,'connection.json'))){
    if(option('server')||option('invite'))throw new Error('This checkout is already connected. Use another checkout to connect a different project.');
    config=loadConnection(dir);
  }else{
    const git=snapshot(repo,option('repository')),name=option('name')??await prompt('Your display name',hostname());
    let server=option('server')??process.env.RELAY_SERVER_URL,projectId=crypto.randomUUID();
    if(option('invite')){
      const encoded=option('invite')!;if(!encoded.startsWith('relay:v1:'))throw new Error('Paste the complete Relay invitation');
      const invite=JSON.parse(Buffer.from(encoded.slice(9),'base64url').toString('utf8'));
      server=serverURL(invite.server);projectId=invite.projectId;
      const joined=await api<{token:string;memberId:string}>(server,projectId,'','join',{code:invite.code,name,repository:git.repository});
      config={server,projectId,...joined,repository:git.repository,name,repo};
    }else{
      server=serverURL(server??await prompt('Relay service URL'));
      let key=option('create-key')??process.env.RELAY_CREATE_KEY;
      const local=join(dir,'local-service.json');
      if(!key&&existsSync(local)){const dev=JSON.parse(readFileSync(local,'utf8'));if(dev.server===server)key=dev.key;}
      if(!key)throw new Error('Set RELAY_CREATE_KEY to create a project, or join using your teammate’s invitation.');
      const created=await api<{token:string;memberId:string}>(server,projectId,key,'create',{name:repo.split(/[\\/]/).pop(),ownerName:name,repository:git.repository});
      config={server,projectId,...created,repository:git.repository,name,repo};
    }
    saveConnection(dir,config);
  }
  const state=new State(dir);state.set('repo',repo);state.close();
  if(!values['no-install']){
    const provider=option('provider')??await prompt('Coding agent: codex, claude or both','both');
    if(!['codex','claude','both'].includes(provider))throw new Error('Provider must be codex, claude or both');
    for(const p of provider==='both'?['codex','claude']: [provider])install(repo,p as Provider,cli);
  }
  if(!values['no-start'])startDaemon(repo);
  console.log(`Connected ${config.name} to ${config.repository}.\n${values['no-start']?'Run relay-next run to synchronize.':'Connector started; relay-next status shows its health.'}\nResume your coding session once to load Relay. Approve its tools/hooks in the coding client.\nUse relay-next invite to invite your teammate.`);
}
async function run(repo:string){
  const dir=stateDir(repo),config=loadConnection(dir),lock=join(dir,'connector.lock');
  if(existsSync(lock)){
    const existing=JSON.parse(readFileSync(lock,'utf8'));let alive=false;try{process.kill(existing.pid,0);alive=true;}catch{/* exited */}
    if(alive)throw new Error('A Relay connector is already running for this repository');unlinkSync(lock);
  }
  const fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));closeSync(fd);
  if(existsSync(join(dir,'stop')))unlinkSync(join(dir,'stop'));
  const state=new State(dir);state.set('repo',repo);
  const connector=new Connector(state,new Remote(config),nativeDelivery(repo));connector.start();console.log('Relay connector running. Ctrl+C stops Relay only.');
  await new Promise<void>(resolve=>{const stop=()=>{clearInterval(timer);resolve();};const timer=setInterval(()=>{if(existsSync(join(dir,'stop')))stop();},1000);process.once('SIGINT',stop);process.once('SIGTERM',stop);});
  await connector.stop();state.close();if(existsSync(lock))unlinkSync(lock);
}
async function main(){
  const cmd=positionals[0]??'help';if(cmd==='help'||values.help){console.log(help);return;}
  const repo=cmd==='hook'?resolve(option('repo')??process.cwd()):root(option('repo')??process.cwd());
  if(cmd==='hook'){
    let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>1_000_000)throw new Error('Hook input too large');}
    try{console.log(JSON.stringify(handleHook(repo,option('provider') as Provider,JSON.parse(data))));}catch(error){console.error(`Relay hook unavailable: ${(error as Error).message}`);console.log('{}');}return;
  }
  if(cmd==='connect'){await connectProject(repo);return;}
  if(cmd==='run'){await run(repo);return;}
  if(cmd==='dev'){
    const dir=stateDir(repo);mkdirSync(dir,{recursive:true,mode:0o700});
    const key=secret(),hub=await startHub(option('dir')??join(dir,'dev-hub'),key,Number(option('port')??7337));
    writeFileSync(join(dir,'local-service.json'),JSON.stringify({server:hub.url,key}),{mode:0o600});
    console.log(`Local development service: ${hub.url}\nConnect this checkout with: relay-next connect --server ${hub.url}\nThis address is available only on this computer.`);
    await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});await hub.close();return;
  }
  if(cmd==='doctor'){
    const agents=[];for(const provider of ['codex','claude'])try{const version=await command(provider,['--version'],repo);agents.push({provider,installed:version.code===0,version:version.stdout.trim()});}catch{agents.push({provider,installed:false});}
    const connected=existsSync(join(stateDir(repo),'connection.json'));
    console.log(JSON.stringify({node:process.version,repo,agents,connected,next:connected?'Resume the coding session; then check status for a registered session.':'Run relay-next connect.'},null,2));return;
  }
  const dir=stateDir(repo),config=loadConnection(dir);
  if(cmd==='stop'){writeFileSync(join(dir,'stop'),'stop');console.log('Requested this repository’s connector to stop. Coding agents continue running.');return;}
  if(cmd==='invite'){
    const invitation=await new Remote(config).call<{code:string;expiresAt:number}>('invite',{});
    const code='relay:v1:'+Buffer.from(JSON.stringify({server:config.server,projectId:config.projectId,code:invitation.code})).toString('base64url');
    console.log(`Single-use invitation; expires ${new Date(invitation.expiresAt).toISOString()}:\n${code}\n\nTeammate: relay-next connect --invite ${code}`);return;
  }
  const state=new State(dir);state.set('repo',repo);
  try{
    if(cmd==='mcp'){await serveMcp(state);return;}
    if(cmd==='status'&&!state.bindings().length){console.log(`Connected to ${config.repository}.\n${state.get<any>('syncError')?.message??'Waiting for a coding session to load Relay’s hooks. Resume Codex or Claude Code in this repository.'}`);return;}
    const sessionId=option('session')??option('from')??((cmd==='status'||state.bindings().length===1)?state.bindings()[0]?.id:undefined);
    if(!sessionId)throw new Error('Choose --session from these connected sessions:\n'+state.bindings().map(s=>`${s.id}  ${s.name}`).join('\n'));
    const result=cmd==='status'?callTool(state,'relay_status',{session_id:sessionId}):cmd==='context'?callTool(state,'relay_context',{session_id:sessionId,query:option('query')??''}):cmd==='ask'?callTool(state,'relay_ask',{session_id:sessionId,target_session_id:option('to'),question:option('message')}):null;
    if(result===null)throw new Error('Unknown command. Run relay-next help.');
    if(cmd==='status'&&!values.json){
      const status=result as any;
      console.log(`Relay · ${config.repository}\n${status.syncError?`Sync unavailable: ${status.syncError.message}`:`Last sync: ${status.lastSync??'waiting'}`} · ${status.pendingUploads} pending uploads\n`);
      for(const session of status.sessions)console.log(`${session.name}  ${session.provider}  ${session.state}${session.freshActivity?'':' (activity stale)'}\n  ${session.task||'No task shared yet'}\n  ${session.git.branch??'detached'} @ ${session.git.head?.slice(0,8)??'unborn'}${session.git.dirty?' + uncommitted changes':''}\n  ${session.id}\n`);
      if(status.overlaps.length)console.log('Overlapping work:',status.overlaps.map((c:any)=>c.paths.join(', ')).join('; '));
      if(status.rejectedUploads.length)console.log('Uploads needing attention:',status.rejectedUploads);
      console.log('Recent directed messages:',status.receipts.slice(0,8).map((r:any)=>`${r.eventId.slice(0,8)} ${r.state}`).join(' · ')||'none');
    }else console.log(JSON.stringify(result,null,2));
  }finally{state.close();}
}
main().catch(error=>{console.error(`Relay: ${(error as Error).message}`);process.exitCode=1;});
