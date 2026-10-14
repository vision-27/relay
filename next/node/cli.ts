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
import { serveMcp, callRelayTool } from './tools.js';
import { Connector } from './connector.js';
import { nativeDelivery, command } from './adapters.js';
import { diagnose, mcpProbe } from './diagnostics.js';
import { accept } from './integration.js';
import { backupProject, pruneArtifacts } from './maintenance.js';
import { startHub } from './hub.js';
import { clientBudget } from './request-budget.js';
import { networkMain } from './network-cli.js';
import { setupNetwork } from './network-setup.js';
import { openSetupWeb } from './setup-web.js';
import { setupRemote, useRemoteSetup } from './remote-setup.js';
import { VERSION } from '../core/version.js';
const cli=fileURLToPath(import.meta.url);
const parsed=parseArgs({allowPositionals:true,options:Object.fromEntries([
  'repo','server','invite','name','provider','repository','session','from','to','message','query','dir','port','create-key','args','id','backup','days','member','role'
].map(name=>[name,{type:'string' as const}]).concat([['version',{type:'boolean'}],['approve',{type:'boolean'}],['json',{type:'boolean'}],['no-install',{type:'boolean'}],['no-start',{type:'boolean'}],['help',{type:'boolean'}],['relay-hook-v1',{type:'boolean'}],['global',{type:'boolean'}],['all-workspaces',{type:'boolean'}],['relay-network-hook-v1',{type:'boolean'}],['web',{type:'boolean'}],['no-open',{type:'boolean'}],['terminal',{type:'boolean'}],['remote',{type:'boolean'}],['legacy-network',{type:'boolean'}]] as any))});
const values=parsed.values as Record<string,string|boolean|undefined>,positionals=parsed.positionals;
const option=(name:string)=>typeof values[name]==='string'?values[name] as string:undefined;
const help=`Relay Next — shared context for your existing coding sessions

  setup                   Open simple Relay setup in your browser
  setup --web             Open the setup screen in your browser
  setup --legacy-network  Configure the optional legacy network connector
  setup --terminal --invite URL --name NAME  Install without opening a browser
  setup --invite CODE     Join a friend; detect clients and configure all workspaces
  connect                 Connect a Git repository; install its agent integration
  connect --global        Install once; connect agents across shared workspaces
  invite --global         Invite a friend to your agent network
  share --global --repo PATH  Share sessions in a workspace and its subfolders
  unshare --global --repo PATH  Hide sessions in that workspace
  share --global --all-workspaces  Share sessions across all workspaces
  discover --global --session ID --name PERSON --query TOPIC
  connect --invite CODE   Join your teammate's project
  invite                  Create a single-use project invitation (24 hours)
  members                 List project members and roles
  member-role --member ID --role admin|member  Owner changes a project role
  status                  Show sessions, freshness, pending uploads and receipts
  context --session ID    Inspect shared context and its code references
  ask --from ID --to ID --message TEXT
  run                     Run this repository's connector in the foreground
  stop                    Stop only this repository's Relay connector
  doctor                  Check connector, MCP startup, session registration and legacy conflicts
  project                 Read accepted revision, tasks and current decisions
  metrics                 Read payload sizes and operation counts
  budget                  Read cached shared monthly budget and pause alerts (local only)
  budget-refresh          Explicitly check whether the owner approved resuming this service
  task --args JSON        Reserve/renew/handoff/release scopes
  artifact --args JSON    Export/receive/read exact selected files
  integration --args JSON Prepare or validate changes in an isolated worktree
  accept --id ID --session ID --approve  Accept a validated integration
  backup                  Export project evidence and artifacts to a local archive
  prune --backup FILE --days 7 --approve  Prune archived, unreferenced artifacts
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
async function startDaemon(repo:string){
  const dir=stateDir(repo),lock=join(dir,'connector.lock');
  if(existsSync(lock)){
    const old=JSON.parse(readFileSync(lock,'utf8'));let alive=false;try{process.kill(old.pid,0);alive=true;}catch{}
    if(alive){
      if(old.version===VERSION&&old.cli===cli)return;
      writeFileSync(join(dir,'stop'),'upgrade');
      for(let i=0;i<50&&existsSync(lock);i++)await new Promise(resolve=>setTimeout(resolve,100));
      if(existsSync(lock))throw new Error('Existing connector has not stopped for upgrade; retry after it exits. Coding sessions were not stopped.');
    }
  }
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
      if(invite.repository&&invite.repository!==git.repository)throw new Error(`Invitation is for ${invite.repository}; this checkout is ${git.repository}. Run connect from the matching checkout.`);
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
  if(!values['no-start'])await startDaemon(repo);
  const mcpReady=values['no-install']?false:await mcpProbe(cli,repo);
  console.log(`MCP executable startup: ${mcpReady?'passed':'not verified'}. This does not confirm the coding session has loaded it.`);
  console.log(`Connected ${config.name} to ${config.repository}.\n${values['no-start']?'Run relay-next run to synchronize.':'Connector started. Session registration begins only when the coding client loads Relay; run relay-next doctor.'}\nResume your coding session once to load Relay. Approve its tools/hooks in the coding client.\nUse relay-next invite to invite your teammate.`);
}
async function run(repo:string){
  const dir=stateDir(repo),config=loadConnection(dir),lock=join(dir,'connector.lock');
  if(existsSync(lock)){
    const existing=JSON.parse(readFileSync(lock,'utf8'));let alive=false;try{process.kill(existing.pid,0);alive=true;}catch{/* exited */}
    if(alive)throw new Error('A Relay connector is already running for this repository');unlinkSync(lock);
  }
  const fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),version:VERSION,cli}));closeSync(fd);
  if(existsSync(join(dir,'stop')))unlinkSync(join(dir,'stop'));
  const state=new State(dir);state.set('repo',repo);
  const connector=new Connector(state,new Remote(config),nativeDelivery(repo));connector.start();console.log('Relay connector running. Ctrl+C stops Relay only.');
  await new Promise<void>(resolve=>{const stop=()=>{clearInterval(timer);resolve();};const timer=setInterval(()=>{if(existsSync(join(dir,'stop')))stop();},1000);process.once('SIGINT',stop);process.once('SIGTERM',stop);});
  await connector.stop();state.close();if(existsSync(lock))unlinkSync(lock);
}
async function main(){
  if(values.version){console.log(VERSION);return;}
  const cmd=positionals[0]??'help';if(cmd==='help'||values.help){console.log(help);return;}
  if(cmd==='budget'){console.log(JSON.stringify(clientBudget.status(),null,2));return;}
  if(cmd==='setup'){
    if(useRemoteSetup(values)){
      if(values.terminal){await setupRemote(values,cli);console.log('Relay installed for all workspaces. Open Claude normally, or reopen Codex and review its Relay hooks.');}
      else await openSetupWeb({...values,remote:true},cli);
      return;
    }
    if(values.web||(!values.terminal&&process.stdin.isTTY&&!option('invite')&&!option('server')))await openSetupWeb(values,cli);
    else await setupNetwork(values,cli);
    return;
  }
  if(values.global){await networkMain(cmd,values,cli);return;}
  const repo=cmd==='hook'?resolve(option('repo')??process.cwd()):root(option('repo')??process.cwd());
  if(cmd==='hook'){
    let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>1_000_000)throw new Error('Hook input too large');}
    try{console.log(JSON.stringify(handleHook(repo,option('provider') as Provider,JSON.parse(data))));}catch(error){console.error(`Relay hook unavailable: ${(error as Error).message}`);console.log('{}');}return;
  }
  if(cmd==='connect'){await connectProject(repo);return;}
  if(cmd==='run'){await run(repo);return;}
  if(cmd==='budget-refresh'){console.log(JSON.stringify(await new Remote(loadConnection(stateDir(repo))).refreshBudget(),null,2));return;}
  if(cmd==='dev'){
    const dir=stateDir(repo);mkdirSync(dir,{recursive:true,mode:0o700});
    const key=secret(),hub=await startHub(option('dir')??join(dir,'dev-hub'),key,Number(option('port')??7337));
    writeFileSync(join(dir,'local-service.json'),JSON.stringify({server:hub.url,key}),{mode:0o600});
    console.log(`Local development service: ${hub.url}\nConnect this checkout with: relay-next connect --server ${hub.url}\nThis address is available only on this computer.`);
    await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});await hub.close();return;
  }
  if(cmd==='doctor'){
    console.log(JSON.stringify({...await diagnose(repo),mcpStarts:existsSync(join(stateDir(repo),'connection.json'))?await mcpProbe(cli,repo):false},null,2));return;
  }
  const dir=stateDir(repo),config=loadConnection(dir);
  if(cmd==='stop'){writeFileSync(join(dir,'stop'),'stop');console.log('Requested this repository’s connector to stop. Coding agents continue running.');return;}
  if(cmd==='members'){
    const shared=await new Remote(config).call<{members:unknown[]}>('snapshot');
    console.log(JSON.stringify(shared.members,null,2));return;
  }
  if(cmd==='member-role'){
    const memberId=option('member'),role=option('role');
    if(!memberId||!['admin','member'].includes(role??''))throw new Error('Use --member ID --role admin|member');
    console.log(JSON.stringify(await new Remote(config).call('members',{memberId,role}),null,2));return;
  }
  if(cmd==='invite'){
    const invitation=await new Remote(config).call<{code:string;expiresAt:number}>('invite',{});
    const code='relay:v1:'+Buffer.from(JSON.stringify({server:config.server,projectId:config.projectId,repository:config.repository,code:invitation.code})).toString('base64url');
    console.log(`Single-use invitation; expires ${new Date(invitation.expiresAt).toISOString()}:\n${code}\n\nTeammate: relay-next connect --invite ${code}`);return;
  }
  const state=new State(dir);state.set('repo',repo);
  try{
    if(cmd==='mcp'){await serveMcp(state);return;}
    if(cmd==='status'&&!state.bindings().length){console.log(JSON.stringify(await diagnose(repo),null,2));return;}
    if(cmd==='backup'){console.log(JSON.stringify(await backupProject(state),null,2));return;}
    const sessionId=option('session')??option('from')??((cmd==='status'||state.bindings().length===1)?state.bindings()[0]?.id:undefined);
    if(!sessionId)throw new Error('Choose --session from these connected sessions:\n'+state.bindings().map(s=>`${s.id}  ${s.name}`).join('\n'));
    if(cmd==='backup'){console.log(JSON.stringify(await backupProject(state),null,2));return;}
    if(cmd==='prune'){if(!values.approve)throw new Error('Pruning requires --approve and a verified backup');console.log(JSON.stringify(await pruneArtifacts(state,sessionId,option('backup')??'',Number(option('days')??7)),null,2));return;}
    if(cmd==='accept'){console.log(JSON.stringify(await accept(state,option('id')??'',sessionId,values.approve===true),null,2));return;}
    const tool=({status:'relay_status',context:'relay_context',ask:'relay_ask',project:'relay_project',metrics:'relay_metrics',task:'relay_task',artifact:'relay_artifact',integration:'relay_integration'} as Record<string,string>)[cmd];
    const args={...(option('args')?JSON.parse(option('args')!):{}),session_id:sessionId,...(cmd==='context'?{query:option('query')??''}:{}),...(cmd==='ask'?{target_session_id:option('to'),question:option('message')}:{})};
    const result=tool?await callRelayTool(state,tool,args):null;
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
