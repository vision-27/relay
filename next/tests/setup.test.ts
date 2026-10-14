import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { temporary } from './helpers.js';
import { detectClients, parseNetworkInvitation } from '../node/network-setup.js';
import { installRuntime } from '../node/network-runtime.js';
import { startHub } from '../node/hub.js';
import { api } from '../node/client.js';
import { loadConnection, saveConnection, State } from '../node/state.js';
import { VERSION } from '../core/version.js';
import { handleHook } from '../node/hooks.js';
import { callRelayTool } from '../node/tools.js';

const source=resolve('out/node/cli.js');
function run(cli:string,args:string[],cwd:string,env:NodeJS.ProcessEnv={},input=''){
  return new Promise<{code:number|null;output:string}>((done,reject)=>{
    const child=spawn(process.execPath,[cli,...args],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,RELAY_CREATE_KEY:undefined,RELAY_SERVER_URL:undefined,...env}});
    let output='';const timeout=setTimeout(()=>{child.kill();reject(new Error('Setup exceeded deadline: '+output));},15000);
    child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('close',code=>{clearTimeout(timeout);done({code,output});});
    child.stdin.end(input);
  });
}
async function fixture(t:test.TestContext){
  const temp=temporary(),hub=await startHub(join(temp.dir,'hub'),'setup-fixture-key');
  t.after(async()=>{await hub.close();temp.cleanup();});
  const projectId=crypto.randomUUID(),repository='network:'+projectId;
  const owner=await api<{token:string;memberId:string}>(hub.url,projectId,'setup-fixture-key','create',{name:'Friends',ownerName:'Owner',repository,mode:'network'});
  const invited=await api<{code:string}>(hub.url,projectId,owner.token,'invite',{});
  const invitation='relay:network:v1:'+Buffer.from(JSON.stringify({server:hub.url,projectId,repository,code:invited.code})).toString('base64url');
  const env={CODEX_HOME:join(temp.dir,'codex config'),CLAUDE_CONFIG_DIR:join(temp.dir,'claude config')};
  mkdirSync(env.CODEX_HOME);mkdirSync(env.CLAUDE_CONFIG_DIR);
  return {...temp,hub,owner,projectId,repository,invitation,env,network:join(temp.dir,'Relay state with spaces')};
}

test('client detection understands Windows shims, Unix binaries, config overrides, and no clients',t=>{
  const {dir}=temporary(t),home=join(dir,'home'),bin=join(dir,'binary folder');mkdirSync(bin);
  assert.deepEqual(detectClients(home,{PATH:''},'linux'),[]);
  writeFileSync(join(bin,'codex.cmd'),'fixture');writeFileSync(join(bin,'claude.exe'),'fixture');
  assert.deepEqual(detectClients(home,{PATH:bin},'win32'),['codex','claude']);
  assert.deepEqual(detectClients(home,{PATH:bin},'darwin'),[]);
  writeFileSync(join(bin,'claude'),'fixture');
  // A Windows drive path is not a valid Unix PATH entry; exercise Unix PATH on Unix CI.
  if(process.platform!=='win32')assert.deepEqual(detectClients(home,{PATH:bin},'linux'),['claude']);
  const custom=join(dir,'custom config');mkdirSync(custom);
  assert.deepEqual(detectClients(home,{PATH:'',CODEX_HOME:custom,CLAUDE_CONFIG_DIR:join(dir,'absent')},'darwin'),['codex']);
});

test('setup persists runtime outside the download cache and probes MCP without model calls',async t=>{
  const {dir}=temporary(t),cache=join(dir,'temporary download'),network=join(dir,'permanent install');
  const temporaryCli=installRuntime(source,cache),installed=installRuntime(temporaryCli,network);
  renameSync(cache,join(dir,'cleared cache'));
  const version=await run(installed,['--version'],dir);assert.equal(version.code,0,version.output);assert.match(version.output,new RegExp(VERSION.replaceAll('.','\\.')));
  assert.equal(installRuntime(source,network),installed,'Repeat installation reuses an identical runtime');
  saveConnection(network,{mode:'network',repo:network,server:'http://127.0.0.1:1',projectId:'fixture',repository:'network:fixture',name:'Fixture',memberId:'fixture',token:'local-fixture'});
  writeFileSync(join(network,'stop'),'test');
  const result=await run(installed,['mcp','--global','--dir',network],dir,{},JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n');
  assert.equal(result.code,0,result.output);assert.match(result.output,/relay-network/);
});

test('desktop setup persists its bundled Node and works after the original installer files are removed',async t=>{
  const f=await fixture(t),download=join(f.dir,'desktop extraction'),cli=installRuntime(source,download);
  const engine=resolve(dirname(cli),'../../engine');mkdirSync(engine);
  copyFileSync(process.execPath,join(engine,process.platform==='win32'?'node.exe':'node'));
  const result=await run(cli,['setup','--dir',f.network,'--invite',f.invitation,'--no-start'],f.dir,f.env);assert.equal(result.code,0,result.output);
  const mcp=JSON.parse(readFileSync(join(f.env.CLAUDE_CONFIG_DIR,'.claude.json'),'utf8')).mcpServers.relay_network;
  assert.ok(mcp.command.startsWith(f.network));assert.match(mcp.command,/engine/);
  const removed=join(f.dir,'removed extraction');
  assert.equal(dirname(resolve(download)),resolve(f.dir));assert.equal(dirname(resolve(removed)),resolve(f.dir));
  // Windows may briefly retain a handle after the bundled executable probe.
  // Keep the relocation assertion, with a bounded retry for transient locks only.
  const deadline=Date.now()+3000;
  for(;;){try{renameSync(download,removed);break;}catch(error){
    if(process.platform!=='win32'||!['EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code??'')||Date.now()>=deadline)throw error;
    await new Promise(done=>setTimeout(done,100));
  }}
  const probe=await promisify(execFile)(mcp.command,[mcp.args[0],'--version'],{windowsHide:true,timeout:10000});assert.equal(probe.stdout.trim(),VERSION);
});

test('one setup command joins outside Git, detects both clients, preserves config and reruns with the same invite',async t=>{
  const f=await fixture(t);
  writeFileSync(join(f.env.CODEX_HOME,'config.toml'),'model = "preserved"\n');
  writeFileSync(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({permissions:{allow:['Read']}}));
  const args=['setup','--dir',f.network,'--invite',f.invitation,'--name','Friend','--no-start'];
  const first=await run(source,args,f.dir,f.env);assert.equal(first.code,0,first.output);assert.match(first.output,/Codex \+ Claude Code/);
  const connection=loadConnection(f.network);assert.equal(connection.mode,'network');assert.equal(connection.name,'Friend');
  const other=join(f.dir,'unrelated folder');mkdirSync(other);
  for(const [provider,cwd] of [['codex',f.dir],['claude',other]] as const){
    const result=handleHook(cwd,provider,{session_id:crypto.randomUUID(),cwd,hook_event_name:'SessionStart'},{},f.network);
    assert.ok(result.hookSpecificOutput,'A session in either folder receives Relay context without workspace setup');
  }
  const state=new State(f.network);try{
    assert.equal(state.get<any>('sharing').all,true);assert.equal(state.bindings().length,2);
    for(const session of state.bindings())await callRelayTool(state,'relay_presence',{session_id:session.id,session_key:session.sessionKey,task:'Ready to share context'});
  }finally{state.close();}
  const codex=readFileSync(join(f.env.CODEX_HOME,'config.toml'),'utf8');assert.match(codex,/preserved/);assert.match(codex,/runtime/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8')).permissions.allow,['Read']);
  const backups=readdirSync(join(f.network,'config-backups')).length;
  const second=await run(source,args,f.dir,f.env);assert.equal(second.code,0,second.output);
  assert.equal(loadConnection(f.network).token,connection.token);assert.equal(readFileSync(join(f.env.CODEX_HOME,'config.toml'),'utf8'),codex);
  assert.equal(readdirSync(join(f.network,'config-backups')).length,backups,'No extra backup files for unchanged settings');
  const snapshot=await api<{members:unknown[]}>(f.hub.url,f.projectId,f.owner.token,'snapshot');assert.equal(snapshot.members.length,2);
});

test('setup detects a conflict in either client before joining or writing the other client',async t=>{
  const f=await fixture(t),path=join(f.env.CLAUDE_CONFIG_DIR,'.claude.json');
  writeFileSync(path,JSON.stringify({mcpServers:{relay_network:{command:'someone-else'}}}));
  const result=await run(source,['setup','--dir',f.network,'--invite',f.invitation,'--all-workspaces','--no-start'],f.dir,f.env);
  assert.notEqual(result.code,0);assert.match(result.output,/needs review/);
  assert.equal(existsSync(join(f.env.CODEX_HOME,'hooks.json')),false);assert.equal(existsSync(join(f.network,'connection.json')),false);
  const invite=parseNetworkInvitation(f.invitation);
  const joined=await api<any>(invite.server,invite.projectId,'','join',{code:invite.code,name:'Still valid',repository:invite.repository});assert.ok(joined.token);
});

test('noninteractive setup only needs an invitation and defaults to all agent workspaces',async t=>{
  const f=await fixture(t);
  const missing=await run(source,['setup','--legacy-network','--dir',f.network,'--provider','codex'],f.dir,f.env);
  assert.notEqual(missing.code,0);assert.match(missing.output,/--invite CODE/);
  const scope=await run(source,['setup','--dir',f.network,'--invite',f.invitation,'--no-start'],f.dir,f.env);
  assert.equal(scope.code,0,scope.output);
  const state=new State(f.network);try{assert.deepEqual(state.get('sharing'),{all:true,roots:[],excluded:[]});}finally{state.close();}
});

test('setup retains folder sharing on upgrades and does not switch to a different invitation',async t=>{
  const f=await fixture(t),privateFolder=join(f.dir,'only this folder');mkdirSync(privateFolder);
  const result=await run(source,['setup','--dir',f.network,'--invite',f.invitation,'--repo',privateFolder,'--no-start'],f.dir,f.env);assert.equal(result.code,0,result.output);
  const before=new State(f.network);const sharing=before.get('sharing');before.close();
  const again=await run(source,['setup','--legacy-network','--dir',f.network,'--no-start'],f.dir,f.env);assert.equal(again.code,0,again.output);
  const after=new State(f.network);try{assert.deepEqual(after.get('sharing'),sharing);}finally{after.close();}
  const altered=parseNetworkInvitation(f.invitation);altered.projectId=crypto.randomUUID();
  const bad='relay:network:v1:'+Buffer.from(JSON.stringify(altered)).toString('base64url');
  const rejected=await run(source,['setup','--dir',f.network,'--invite',bad,'--no-start'],f.dir,f.env);assert.notEqual(rejected.code,0);assert.match(rejected.output,/different network/);
});

test('invalid invitations fail without echoing secret input',()=>{
  for(const invitation of ['private-secret', 'relay:network:v1:e30', 'relay:network:v1:!!!!']){
    assert.throws(()=>parseNetworkInvitation(invitation),error=>error instanceof Error&&!error.message.includes(invitation)&&/not valid/.test(error.message));
  }
});

test('guided setup asks only for invitation and display name, never a workspace',async t=>{
  const f=await fixture(t),script=join(f.dir,'guided.mjs');
  writeFileSync(script,`import { setupNetwork } from ${JSON.stringify(pathToFileURL(resolve('out/node/network-setup.js')).href)};
    const replies=${JSON.stringify([f.invitation,'Friend'])};
    await setupNetwork({dir:${JSON.stringify(f.network)},'no-start':true},${JSON.stringify(source)},{
      interactive:true, log:console.log, ask:async question=>{console.log(question);if(!replies.length)throw new Error('Unexpected extra setup question');return replies.shift();}
    });
    if(replies.length)throw new Error('Wizard skipped a required choice');
  `);
  const result=await run(script,[],f.dir,f.env);assert.equal(result.code,0,result.output);
  assert.match(result.output,/Paste your friend's Relay invitation/);assert.match(result.output,/Your display name/);
  assert.equal(result.output.includes(f.invitation),false);
  const state=new State(f.network);try{assert.deepEqual(state.get('sharing'),{all:true,roots:[],excluded:[]});}finally{state.close();}
});
