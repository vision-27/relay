import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Provider } from '../core/types.js';
import { quote, writeConfig } from './install.js';

export function planNetworkInstall(provider:Provider,cli:string,dir:string,home=homedir(),node=process.execPath,codexHome=process.env.CODEX_HOME??join(home,'.codex'),claudeHome=process.env.CLAUDE_CONFIG_DIR??join(home,'.claude')) {
  const hookPath=provider==='codex'?join(codexHome,'hooks.json'):join(claudeHome,'settings.json');
  const customClaude=!!process.env.CLAUDE_CONFIG_DIR||resolve(claudeHome)!==resolve(join(home,'.claude'));
  const mcpPath=provider==='codex'?join(codexHome,'config.toml'):join(customClaude?claudeHome:home,'.claude.json');
  for(const target of [home,codexHome,claudeHome,dir,join(dir,'config-backups'),hookPath,mcpPath]){
    let current=target;while(true){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error(`Relay will not install through a symlink: ${current}`);const parent=dirname(current);if(parent===current)break;current=parent;}
  }
  const config=existsSync(hookPath)?JSON.parse(readFileSync(hookPath,'utf8')):{};config.hooks??={};
  const command=`${quote(node)} ${quote(cli)} hook --global --dir ${quote(dir)} --provider ${provider} --relay-network-hook-v1`;
  for(const event of ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','SessionEnd']){
    config.hooks[event]=(config.hooks[event]??[]).map((group:any)=>({...group,hooks:(group.hooks??[]).filter((hook:any)=>!hook.command?.includes('--relay-network-hook-v1'))})).filter((group:any)=>group.hooks.length);
    config.hooks[event].push({hooks:[{type:'command',command,timeout:event==='SessionEnd'?3:10}]});
  }
  let mcpText:string;
  if(provider==='codex'){
    const old=existsSync(mcpPath)?readFileSync(mcpPath,'utf8'):'';
    const clean=old.replace(/\n?# BEGIN RELAY NETWORK[\s\S]*?# END RELAY NETWORK\n?/g,'');
    if(/^\s*\[mcp_servers\.(?:relay_network|"relay_network"|'relay_network')(?:\.|\])/m.test(clean))throw new Error('Existing relay_network MCP entry needs review');
    mcpText=clean.trimEnd()+`\n\n# BEGIN RELAY NETWORK\n[mcp_servers.relay_network]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([cli,'mcp','--global','--dir',dir])}\n# END RELAY NETWORK\n`;
  }else{
    const mcp=existsSync(mcpPath)?JSON.parse(readFileSync(mcpPath,'utf8')):{};mcp.mcpServers??={};
    const previous=mcp.mcpServers.relay_network;
    if(previous&&!(previous.args?.includes('--global')&&previous.args?.includes('mcp')&&previous.args?.some((arg:unknown)=>typeof arg==='string'&&arg.replaceAll('\\','/').endsWith('/out/node/cli.js'))))throw new Error('Existing relay_network MCP entry needs review');
    mcp.mcpServers.relay_network={type:'stdio',command:node,args:[cli,'mcp','--global','--dir',dir]};mcpText=JSON.stringify(mcp,null,2)+'\n';
  }
  return {provider,updates:[{path:hookPath,text:JSON.stringify(config,null,2)+'\n'},{path:mcpPath,text:mcpText}]};
}

export function applyNetworkInstall(plan:ReturnType<typeof planNetworkInstall>,dir:string) {
  for(const update of plan.updates){
    if(existsSync(update.path)&&readFileSync(update.path,'utf8')===update.text)continue;
    writeConfig(update.path,update.text,join(dir,'config-backups'));
  }
  return {provider:plan.provider,files:plan.updates.map(update=>update.path),next:'Resume the coding client and review its Relay Network MCP/hook trust prompts.'};
}

export function installNetwork(...args:Parameters<typeof planNetworkInstall>) {
  return applyNetworkInstall(planNetworkInstall(...args),args[2]);
}
