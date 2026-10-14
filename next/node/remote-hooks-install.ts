import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeCodexRemoteHooks } from '../core/remote-hooks.js';
import { writeConfig } from './install.js';

export function installRemoteInboxHooks(home=process.env.CODEX_HOME??join(homedir(),'.codex')){
  const config=join(home,'config.toml');
  if(!existsSync(config)||!/^\s*\[mcp_servers\.relay_remote\]/m.test(readFileSync(config,'utf8')))throw Error('Connect the relay_remote MCP server in Codex first');
  const path=join(home,'hooks.json'),original=existsSync(path)?readFileSync(path,'utf8'):undefined;
  const updated=JSON.stringify(mergeCodexRemoteHooks(original?JSON.parse(original):{}),null,2)+'\n';
  if(updated!==original)writeConfig(path,updated,join(home,'relay-hook-backups'));
  return {path,changed:updated!==original,next:'Reopen Codex, review and trust the two Relay hooks in /hooks, then resume the conversation. No Relay runtime or daemon is installed.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(installRemoteInboxHooks(),null,2));}
  catch(error){console.error((error as Error).message);process.exitCode=1;}
}
