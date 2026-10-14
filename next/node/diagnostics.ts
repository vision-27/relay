import { existsSync, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { State, loadConnection, stateDir } from './state.js';
import { Remote } from './client.js';
import { spawn } from 'node:child_process';
import { VERSION } from '../core/version.js';
export async function diagnose(repo:string){
  const dir=stateDir(repo),connected=existsSync(join(dir,'connection.json'));
  const globalConfig=join(homedir(),'.codex','config.toml'),text=existsSync(globalConfig)?readFileSync(globalConfig,'utf8'):'';
  const legacy=[...text.matchAll(/\[mcp_servers\.(relay-[^\]]+)\]([^]*?)(?=\n\[|$)/g)].filter(m=>!/^enabled\s*=\s*false/m.test(m[2]!)).map(m=>m[1]);
  const onPath=(process.env.PATH??'').split(delimiter).some(p=>existsSync(join(p,process.platform==='win32'?'relay-next.cmd':'relay-next')));
  if(!connected)return {repo,connected:false,commandOnPath:onPath,legacyIntegrations:legacy,next:'Run relay-next connect in this checkout.'};
  const config=loadConnection(dir),state=new State(dir);
  try{
    let connectorRunning=false;try{process.kill(JSON.parse(readFileSync(join(dir,'connector.lock'),'utf8')).pid,0);connectorRunning=true;}catch{}
    let remoteStatus:unknown;try{const shared=await new Remote(config).call<any>('snapshot');remoteStatus={reachable:true,protocol:shared.protocol??1,peers:shared.sessions.map((s:any)=>({id:s.id,name:s.name,state:s.state,updatedAt:s.updatedAt}))};}catch(error){remoteStatus={reachable:false,error:(error as Error).message};}
    const sessions=state.bindings().map(b=>({id:b.id,provider:b.provider,state:b.state,lastHookAt:b.hookSeenAt?new Date(b.hookSeenAt).toISOString():null}));
    return {version:VERSION,repo,repository:config.repository,projectId:config.projectId,server:config.server,connected:true,connectorRunning,commandOnPath:onPath,legacyIntegrations:legacy,localSessions:sessions,lastSync:state.get('lastSync')??null,syncError:state.get('syncError')??null,remote:remoteStatus,next:!sessions.length?'Resume the coding session in this exact checkout and approve Relay MCP/hooks. Connector health alone is not agent registration.':legacy.length?'Disable the listed legacy integrations to avoid using the wrong project.':'Use project/status to inspect peer activity; a reply confirms end-to-end delivery.'};
  }finally{state.close();}
}
export async function mcpProbe(cli:string,repo:string){
  return new Promise<boolean>(resolve=>{const child=spawn(process.execPath,[cli,'mcp','--repo',repo],{windowsHide:true,stdio:['pipe','pipe','pipe']});let result='';const timer=setTimeout(()=>{child.kill();resolve(false);},5000);child.stdout.on('data',data=>result+=data);child.on('error',()=>{clearTimeout(timer);resolve(false);});child.on('close',()=>{clearTimeout(timer);try{resolve(result.trim().split('\n').some(line=>JSON.parse(line).result?.serverInfo?.name==='relay-next'));}catch{resolve(false);}});child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n');});
}
