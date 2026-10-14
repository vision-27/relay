import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeConfig } from './install.js';
import { assertRealPath, installRuntime, runtimeNode } from './network-runtime.js';

export function companionConfig(original:string,node:string,entry:string,connection:string){
  const header=/^\[mcp_servers\.relay_remote\]\s*$/m,found=header.exec(original);
  if(!found)throw Error('Connect relay_remote in Codex first');
  const start=found.index,tail=original.slice(start+found[0].length);
  const next=/^\[(?!mcp_servers\.relay_remote\.)[^\n]+\]/m.exec(tail);
  const end=next?start+found[0].length+next.index:original.length;
  const block=`[mcp_servers.relay_remote]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([entry,connection])}\n\n`;
  return original.slice(0,start)+block+original.slice(end);
}

export function installRemoteCompanion(connectionPath:string,home=process.env.CODEX_HOME??join(homedir(),'.codex'),dir=join(homedir(),'.relay','remote-companion')){
  const configPath=join(home,'config.toml');assertRealPath(configPath);assertRealPath(dir);
  if(!existsSync(configPath))throw Error('Connect relay_remote in Codex first');
  const connection=JSON.parse(readFileSync(connectionPath,'utf8'));
  if(!connection.token||!connection.projectId||new URL(connection.server).protocol!=='https:')throw Error('A hosted Relay connection is required');
  const installed=installRuntime(join(dirname(fileURLToPath(import.meta.url)),'cli.js'),dir),node=runtimeNode(installed);
  const entry=join(dirname(installed),'remote-companion-mcp.js'),privatePath=join(dir,'connection.json');
  const config=companionConfig(readFileSync(configPath,'utf8'),node,entry,privatePath);
  const backup=join(dir,'backups');
  writeConfig(privatePath,JSON.stringify({server:connection.server,projectId:connection.projectId,token:connection.token})+'\n',backup);
  writeConfig(configPath,config,backup);
  return {node,entry,listener:join(dirname(installed),'remote-companion.js'),connectionPath:privatePath,next:'Relay companion starts with the relay_remote MCP connection. Reopen Codex to load the updated connection.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{if(!process.argv[2])throw Error('Pass your private Relay connection JSON file');console.log(JSON.stringify(installRemoteCompanion(resolve(process.argv[2])),null,2));}
  catch(error){console.error((error as Error).message);process.exitCode=1;}
}
