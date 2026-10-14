import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider } from '../core/types.js';
import { networkDir } from './network-state.js';
import { networkMain } from './network-cli.js';
import { planNetworkInstall } from './network-install.js';
import { assertRealPath, installRuntime, runtimeNode } from './network-runtime.js';
import { loadConnection } from './state.js';
import { serverURL } from './client.js';
import { VERSION } from '../core/version.js';

type Options=Record<string,string|boolean|undefined>;
export interface SetupIO {
  interactive:boolean;
  ask:(question:string,fallback?:string)=>Promise<string>;
  log:(message:string)=>void;
}
export function detectClients(home=homedir(),env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):Provider[] {
  const onPath=(name:string)=>(env.PATH??env.Path??'').split(platform==='win32'?';':':').filter(Boolean).some(folder=>
    (platform==='win32'?['.exe','.cmd','.bat','']:['']).some(ext=>{
      try{return statSync(join(folder.replace(/^"|"$/g,''),name+ext)).isFile();}catch{return false;}
    }));
  return (['codex','claude'] as Provider[]).filter(provider=>
    existsSync(provider==='codex'?(env.CODEX_HOME??join(home,'.codex')):(env.CLAUDE_CONFIG_DIR??join(home,'.claude')))||
    (provider==='claude'&&!env.CLAUDE_CONFIG_DIR&&existsSync(join(home,'.claude.json')))||onPath(provider));
}
export function parseNetworkInvitation(value:string) {
  try {
    if(!/^relay:network:v1:[A-Za-z0-9_-]{1,12000}$/.test(value))throw new Error();
    const parsed=JSON.parse(Buffer.from(value.slice('relay:network:v1:'.length),'base64url').toString('utf8'));
    if(typeof parsed.server!=='string'||parsed.server.length>2048||typeof parsed.projectId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(parsed.projectId)||
      typeof parsed.repository!=='string'||!parsed.repository.length||parsed.repository.length>500||typeof parsed.code!=='string'||!parsed.code.length||parsed.code.length>512)throw new Error();
    return {server:serverURL(parsed.server),projectId:parsed.projectId,repository:parsed.repository,code:parsed.code};
  }catch{throw new Error('That invitation is not valid. Paste the complete Relay Network invitation from your friend.');}
}

export async function setupNetwork(values:Options,cli:string,io?:SetupIO) {
  let reader:ReturnType<typeof createInterface>|undefined;
  const ui=io??{interactive:!!process.stdin.isTTY&&!!process.stdout.isTTY,log:console.log,
    ask:async(question:string,fallback?:string)=>{
      reader??=createInterface({input:process.stdin,output:process.stdout});
      return (await reader.question(`${question}${fallback?` [${fallback}]`:''}: `)).trim()||fallback||'';
    }};
  try {
    const settings={...values},option=(name:string)=>typeof settings[name]==='string'?settings[name] as string:undefined;
    const dir=resolve(option('dir')??networkDir());assertRealPath(dir);
    const existing=existsSync(join(dir,'connection.json'))?loadConnection(dir):undefined;
    if(existing&&existing.mode!=='network')throw new Error('This directory belongs to a repository connection. Choose a different --dir.');
    if(settings['no-install'])throw new Error('Setup installs your client integration. For a transport-only connection, use connect --global --no-install.');
    if(option('repo')&&settings['all-workspaces'])throw new Error('Choose --repo PATH or --all-workspaces, not both.');
    let providers:Provider[];
    const requested=option('provider')??'auto';
    if(!['auto','codex','claude','both'].includes(requested))throw new Error('Choose --provider auto, codex, claude or both.');
    providers=requested==='auto'?detectClients():requested==='both'?['codex','claude']:[requested as Provider];
    if(!providers.length&&ui.interactive){
      const choice=(await ui.ask('Which coding client do you use? codex, claude, or both')).toLowerCase();
      if(!['codex','claude','both'].includes(choice))throw new Error('Run setup again with --provider codex, claude or both.');
      providers=choice==='both'?['codex','claude']:[choice as Provider];
    }
    if(!providers.length)throw new Error('No coding client detected. Install Codex or Claude Code, or specify --provider codex, claude or both.');
    settings.provider=providers.length===2?'both':providers[0];
    ui.log(`Relay setup\nClients: ${providers.map(p=>p==='codex'?'Codex':'Claude Code').join(' + ')}`);
    if(existing){
      if(option('invite')){
        const invite=parseNetworkInvitation(option('invite')!);
        if(invite.server!==serverURL(existing.server)||invite.projectId!==existing.projectId||invite.repository!==existing.repository)throw new Error('Already connected to a different network. Setup will not replace it.');
        delete settings.invite; // Retrying setup never consumes the single-use invitation again.
      }
      if(option('server')&&serverURL(option('server')!)!==serverURL(existing.server))throw new Error('Already connected to a different service.');
      delete settings.server;
      ui.log(`Updating the installation for ${existing.name}; keeping your connection and sharing settings.`);
    }else{
      if(!option('invite')&&!option('server')&&!process.env.RELAY_SERVER_URL){
        if(!ui.interactive)throw new Error('Run relay setup in a terminal to paste an invitation, or supply --invite CODE.');
        settings.invite=await ui.ask('Paste your friend\'s Relay invitation');
      }
      if(option('invite'))parseNetworkInvitation(option('invite')!);
      else if(!(option('create-key')??process.env.RELAY_CREATE_KEY))throw new Error('To join, use your friend\'s invitation. Creating a network requires an operator key.');
      if(!option('name'))settings.name=ui.interactive?await ui.ask('Your display name',userInfo().username):userInfo().username;
      if(!option('name')?.trim()||option('name')!.length>80)throw new Error('Choose a display name between 1 and 80 characters.');
    }
    if(option('repo'))settings.repo=realpathSync(option('repo')!);
    // Preflight all clients before consuming an invitation or modifying any client config.
    for(const provider of providers)planNetworkInstall(provider,cli,dir);
    const installed=installRuntime(cli,dir);
    const node=runtimeNode(installed);
    for(const provider of providers)planNetworkInstall(provider,installed,dir,undefined,node);
    const probe=await promisify(execFile)(node,[installed,'--version'],{windowsHide:true,timeout:10000});
    if(probe.stdout.trim()!==VERSION)throw new Error('The installed Relay runtime did not pass its startup check.');
    await networkMain('connect',{...settings,dir,quiet:true},installed);
    ui.log(`\nRelay is configured for ${providers.map(p=>p==='codex'?'Codex':'Claude Code').join(' + ')}.\nOpen or resume your coding client once and accept its Relay trust prompt if shown.\nThen say: "Find my friend\'s agent on Relay."\n\nNo per-project setup or separate terminal is needed. Incoming delivery is confirmed only after the receiving agent acknowledges it.`);
    if(settings['no-start'])ui.log('Background receiver startup was skipped (--no-start).');
    return {dir,cli:installed,providers};
  }finally{reader?.close();}
}
