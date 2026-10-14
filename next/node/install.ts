import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Provider } from '../core/types.js';
import { stateDir } from './state.js';
export function writeConfig(path:string,text:string,backupDir:string){
  mkdirSync(dirname(path),{recursive:true});mkdirSync(backupDir,{recursive:true,mode:0o700});
  if(existsSync(path))copyFileSync(path,join(backupDir,`${Date.now()}-${crypto.randomUUID()}.json`));
  const temp=path+`.relay-${crypto.randomUUID()}.tmp`;writeFileSync(temp,text,{mode:0o600});renameSync(temp,path);
}
export function quote(value:string){
  if(process.platform==='win32'){
    if(/["\r\n%`$]/.test(value))throw new Error('This install path needs manual hook configuration because it contains shell metacharacters');
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function install(repo:string,provider:Provider,cli:string,node=process.execPath){
  for(const relative of ['.relay','.relay/next','.relay/next/config-backups','.codex','.claude','.mcp.json','.codex/hooks.json','.codex/config.toml','.claude/settings.local.json','.gitignore']){
    const target=join(repo,relative);if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw new Error(`Relay will not install through a symlink: ${relative}`);
  }
  const backup=join(stateDir(repo),'config-backups');
  const command=`${quote(node)} ${quote(cli)} hook --provider ${provider} --repo ${quote(repo)} --relay-hook-v1`;
  const updates:{path:string;text:string}[]=[];
  const events=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','SessionEnd'];
  const path=join(repo,provider==='codex'?'.codex/hooks.json':'.claude/settings.local.json');
  const config=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};config.hooks??={};
  for(const event of events){
    const existing=config.hooks[event]??[];
    config.hooks[event]=existing.map((group:any)=>({...group,hooks:(group.hooks??[]).filter((hook:any)=>!(hook.command?.includes('--relay-hook-v1')||(hook.command?.includes(cli)&&hook.command?.includes(' hook --provider '))))})).filter((group:any)=>group.hooks.length);
    config.hooks[event].push({hooks:[{type:'command',command,timeout:10}]});
  }
  updates.push({path,text:JSON.stringify(config,null,2)+'\n'});
  if(provider==='claude'){
    const mcpPath=join(repo,'.mcp.json'),mcp=existsSync(mcpPath)?JSON.parse(readFileSync(mcpPath,'utf8')):{};
    mcp.mcpServers??={};
    const previous=mcp.mcpServers.relay_next;
    if(previous&&!previous.args?.some((arg:unknown)=>typeof arg==='string'&&arg.replaceAll('\\','/').endsWith('/out/node/cli.js')))throw new Error('An existing relay_next MCP entry needs review before replacement');
    mcp.mcpServers.relay_next={command:node,args:[cli,'mcp','--repo',repo]};updates.push({path:mcpPath,text:JSON.stringify(mcp,null,2)+'\n'});
  }else{
    const mcpPath=join(repo,'.codex/config.toml'),existing=existsSync(mcpPath)?readFileSync(mcpPath,'utf8'):'';
    const begin='# BEGIN RELAY NEXT',end='# END RELAY NEXT';
    const cleaned=existing.replace(/\n?# BEGIN RELAY NEXT[\s\S]*?# END RELAY NEXT\n?/g,'');
    if(/^\s*\[mcp_servers\.relay_next\]/m.test(cleaned))throw new Error('An existing relay_next MCP configuration needs review before replacement');
    updates.push({path:mcpPath,text:`${cleaned.trimEnd()}\n\n${begin}\n[mcp_servers.relay_next]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([cli,'mcp','--repo',repo])}\n${end}\n`});
  }
  const ignore=join(repo,'.gitignore'),original=existsSync(ignore)?readFileSync(ignore,'utf8'):'';
  const add=['.relay/','.mcp.json','.claude/settings.local.json','.codex/hooks.json','.codex/config.toml'].filter(p=>!original.split(/\r?\n/).includes(p));
  if(add.length)updates.push({path:ignore,text:original+(original.endsWith('\n')?'':'\n')+'\n# Relay local connection and agent integration\n'+add.join('\n')+'\n'});
  for(const update of updates)writeConfig(update.path,update.text,backup);
  return {provider,files:[path],next:'Resume your coding session and approve the Relay MCP/hooks when prompted by the coding client.'};
}
