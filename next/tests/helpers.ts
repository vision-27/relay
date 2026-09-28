import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import type { GitState } from '../core/types.js';
import { snapshot } from '../node/git.js';
import { State, saveConnection, stateDir, type Binding, type Connection } from '../node/state.js';
import { startHub } from '../node/hub.js';
import { api, Remote } from '../node/client.js';
import { Connector } from '../node/connector.js';
import type { Deliver } from '../node/adapters.js';
export function temporary(t?:TestContext){
  const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'relay-next-'));
  const cleanup=()=>{if(dirname(realpathSync(dir))!==parent)throw new Error('Unexpected test directory');rmSync(dir,{recursive:true,force:true});};
  t?.after(cleanup);return {dir,cleanup};
}
export function git(repo:string,...args:string[]){return execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();}
export function repository(dir:string){
  mkdirSync(dir,{recursive:true});git(dir,'init','-q');writeFileSync(join(dir,'README.md'),'fixture\n');git(dir,'add','README.md');
  git(dir,'-c','user.email=test@relay.invalid','-c','user.name=Relay Test','-c','commit.gpgsign=false','commit','-qm','fixture');
  git(dir,'remote','add','origin','https://example.invalid/team/repo.git');return realpathSync(dir);
}
export const code:GitState={head:'a'.repeat(40),branch:'main',dirty:false,files:[],fingerprint:'a'.repeat(64),repository:'example.invalid/team/repo'};
export function binding(memberId:string,provider:'codex'|'claude',id=crypto.randomUUID(),git=code):Binding {
  return {id,memberId,provider,sourceId:crypto.randomUUID(),name:provider,git,task:'Build authentication',scopes:['src/auth'],state:'active',updatedAt:new Date().toISOString(),hookSeenAt:Date.now()};
}
export async function pair(t?:TestContext,deliver?:Deliver){
  const temp=temporary(),aRepo=repository(join(temp.dir,'alice')),bRepo=repository(join(temp.dir,'bob'));
  const key='test-operator-key',projectId=crypto.randomUUID(),hub=await startHub(join(temp.dir,'hub'),key);
  const a=await api<{token:string;memberId:string}>(hub.url,projectId,key,'create',{name:'Demo',ownerName:'Alice',repository:code.repository});
  const invite=await api<{code:string}>(hub.url,projectId,a.token,'invite',{});
  const b=await api<{token:string;memberId:string}>(hub.url,projectId,'','join',{code:invite.code,name:'Bob',repository:code.repository});
  const connect=(repo:string,user:typeof a,name:string,provider:'codex'|'claude')=>{
    const config:Connection={server:hub.url,projectId,...user,repo,name,repository:code.repository};saveConnection(stateDir(repo),config);
    const state=new State(stateDir(repo));state.set('repo',repo);const session=binding(user.memberId,provider,crypto.randomUUID(),snapshot(repo));state.bind(session);
    const connector=new Connector(state,new Remote(config),deliver??(async()=>({state:'accepted',detail:'Test adapter accepted input'})));
    return {config,state,session,connector,repo};
  };
  const alice=connect(aRepo,a,'Alice','codex'),bob=connect(bRepo,b,'Bob','claude');
  await alice.connector.tick();await bob.connector.tick();await alice.connector.tick();
  const cleanup=async()=>{await alice.connector.stop();await bob.connector.stop();alice.state.close();bob.state.close();await hub.close();temp.cleanup();};
  t?.after(cleanup);return {alice,bob,hub,projectId,key,temp,cleanup};
}
