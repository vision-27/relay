import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { temporary } from './helpers.js';
import { claudeLauncher, windowsClaudeLauncherScript, parseRemoteInvitation, setupRemote, useRemoteSetup } from '../node/remote-setup.js';
import { startSetupWeb } from '../node/setup-web.js';

const invitation='https://relay.example/connect#'+encodeURIComponent(JSON.stringify({projectId:'fixture',code:'a'.repeat(64)}));
test('simple setup defaults to the hosted invitation flow and recognizes legacy invitations',()=>{
  assert.equal(useRemoteSetup({}),true);assert.equal(useRemoteSetup({invite:invitation}),true);
  assert.equal(useRemoteSetup({invite:'relay:network:v1:fixture'}),false);assert.equal(useRemoteSetup({'legacy-network':true}),false);
  assert.throws(()=>useRemoteSetup({remote:true,'legacy-network':true}),/not both/);
});
test('remote setup parses invite links without exposing codes and rejects unsafe URLs',()=>{
  assert.equal(parseRemoteInvitation(invitation).projectId,'fixture');
  for(const bad of ['https://relay.example/connect#SECRET','http://remote.example/connect#'+invitation.split('#')[1],invitation.replace('/connect','/wrong'),invitation.replace('https://','https://name:secret@')])assert.throws(()=>parseRemoteInvitation(bad),error=>!String(error).includes('SECRET')&&!String(error).includes('name:secret'));
});

test('remote setup connects both clients without Git and survives a repeat install without redeeming twice',async t=>{
  const {dir}=temporary(t),home=join(dir,'User Home'),state=join(home,'.relay','remote-mcp');
  mkdirSync(join(home,'.codex'),{recursive:true});
  writeFileSync(join(home,'.codex','config.toml'),'model = "keep-me"\n[mcp_servers.other]\nurl = "https://other.example"\n');
  writeFileSync(join(home,'.codex','hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'keep-me'}]}]}}));
  writeFileSync(join(home,'.claude.json'),JSON.stringify({theme:'dark',mcpServers:{other:{command:'keep-me'}}}));
  let calls=0;
  const environment={home,env:{},platform:'win32' as const,enroll:async()=>{calls++;return {token:'fixture-private-token',memberId:'member'} as any;}};
  const result=await setupRemote({dir:state,invite:invitation,name:'Friend',provider:'both'},resolve('out/node/cli.js'),undefined,environment);
  assert.equal(calls,1);assert.deepEqual(result.providers,['codex','claude']);
  const codex=readFileSync(join(home,'.codex','config.toml'),'utf8'),claude=JSON.parse(readFileSync(join(home,'.claude.json'),'utf8'));
  assert.match(codex,/keep-me/);assert.match(codex,/remote-companion-mcp/);assert.doesNotMatch(codex,/fixture-private-token/);
  assert.equal(claude.theme,'dark');assert.equal(claude.mcpServers.other.command,'keep-me');assert.ok(existsSync(claude.mcpServers.relay_remote.args[0]));
  const hooks=JSON.parse(readFileSync(join(home,'.codex','hooks.json'),'utf8'));assert.equal(hooks.hooks.Stop.length,2);
  assert.match(readFileSync(result.launcher!,'utf8'),/--dangerously-load-development-channels/);assert.doesNotMatch(readFileSync(result.launcher!,'utf8'),/bypassPermissions|skip-permissions|fixture-private-token/);
  assert.doesNotMatch(windowsClaudeLauncherScript(),/bypassPermissions|skip-permissions|fixture-private-token/);
  await setupRemote({dir:state,invite:invitation,name:'Friend',provider:'both'},resolve('out/node/cli.js'),undefined,environment);
  assert.equal(calls,1);assert.equal(JSON.parse(readFileSync(join(home,'.codex','hooks.json'),'utf8')).hooks.Stop.length,2);
});

test('remote setup preflights all configs before consuming an invite and retains saved enrollment after a later conflict',async t=>{
  const {dir}=temporary(t),home=join(dir,'home'),state=join(dir,'state');mkdirSync(home);
  writeFileSync(join(home,'.claude.json'),'{invalid');let calls=0;
  const options={dir:state,invite:invitation,name:'Friend',provider:'claude'};
  const environment={home,env:{},enroll:async()=>{calls++;writeFileSync(join(home,'.claude.json'),'{}\n');return {token:'fixture-private-token',memberId:'member'} as any;}};
  await assert.rejects(setupRemote(options,resolve('out/node/cli.js'),undefined,environment));assert.equal(calls,0);
  writeFileSync(join(home,'.claude.json'),'{}');
  await assert.rejects(setupRemote(options,resolve('out/node/cli.js'),undefined,environment),/settings changed/);
  assert.equal(calls,1);assert.ok(existsSync(join(state,'connection.json')));
  await setupRemote(options,resolve('out/node/cli.js'),undefined,environment);assert.equal(calls,1);
});

test('macOS launcher handles standard install locations and preserves normal Claude permissions',()=>{
  const source=claudeLauncher('darwin');assert.match(source,/HOME\/\.local\/bin/);assert.match(source,/opt\/homebrew\/bin/);assert.match(source,/exec claude/);assert.doesNotMatch(source,/bypassPermissions|skip-permissions/);
});

test('Windows launcher preserves a project and safely handles folder selection and cancellation', {skip:process.platform!=='win32'},t=>{
  const {dir}=temporary(t),bin=join(dir,'bin'),home=join(dir,'home'),project=join(dir,"Project & user's [draft] !"),output=join(dir,'result.json');
  for(const path of [bin,home,project])mkdirSync(path);
  writeFileSync(join(bin,'record.cjs'),"require('fs').writeFileSync(process.env.RELAY_TEST_OUTPUT, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))");
  writeFileSync(join(bin,'claude.cmd'),'@echo off\r\n"'+process.execPath+'" "'+join(bin,'record.cjs')+'" %*\r\n');
  const env={...process.env,PATH:bin+';'+process.env.PATH,USERPROFILE:home,RELAY_TEST_OUTPUT:output,RELAY_TEST_PROJECT:project,RELAY_CLAUDE_PICK_FOLDER:''};
  const run=(cwd:string,selector:string,force=false)=>spawnSync('powershell.exe',['-NoProfile','-STA','-EncodedCommand',Buffer.from('& {\n'+windowsClaudeLauncherScript()+'\n} -SelectProject { '+selector+' }','utf16le').toString('base64')],{cwd,env:{...env,RELAY_CLAUDE_START_DIR:cwd,RELAY_CLAUDE_PICK_FOLDER:force?'1':''},encoding:'utf8',windowsHide:true,timeout:15000});
  const direct=run(project,"throw 'Unexpected folder chooser'");assert.equal(direct.status,0,direct.stdout+direct.stderr);
  let result=JSON.parse(readFileSync(output,'utf8'));assert.equal(result.cwd,project);assert.ok(result.args.includes('--dangerously-load-development-channels'));assert.ok(result.args.includes('server:relay_remote'));
  for(const [cwd,force] of [[home,false],[project,true]] as const){
    const chosen=run(cwd,'$env:RELAY_TEST_PROJECT',force);assert.equal(chosen.status,0,chosen.stdout+chosen.stderr);assert.equal(JSON.parse(readFileSync(output,'utf8')).cwd,project);
  }
  writeFileSync(output,'not launched');
  const cancelled=run(home,'$null');assert.equal(cancelled.status,0,cancelled.stdout+cancelled.stderr);assert.equal(readFileSync(output,'utf8'),'not launched');
  const root=run(home,'[IO.Path]::GetPathRoot($env:USERPROFILE)');assert.equal(root.status,1);assert.equal(readFileSync(output,'utf8'),'not launched');
  const missing=run(home,"Join-Path $env:USERPROFILE 'missing-project'");assert.equal(missing.status,1);assert.equal(readFileSync(output,'utf8'),'not launched');
  // Exercise the shipped batch wrapper too, without starting the real agent.
  const launcher=join(dir,'Claude with Relay.cmd');writeFileSync(launcher,claudeLauncher('win32'));
  const batch=spawnSync(process.env.ComSpec??'cmd.exe',['/d','/s','/c','""'+launcher+'""'],{cwd:project,env,encoding:'utf8',windowsVerbatimArguments:true,windowsHide:true,timeout:15000});
  assert.equal(batch.status,0,batch.stdout+batch.stderr);assert.equal(JSON.parse(readFileSync(output,'utf8')).cwd,project);
});

test('POSIX launcher keeps project paths and cancels desktop selection without starting Claude', {skip:process.platform==='win32'},t=>{
  const {dir}=temporary(t),bin=join(dir,'bin'),home=join(dir,'home'),project=join(dir,"Project & user's [draft] !"),output=join(dir,'result.json');
  for(const path of [bin,home,project])mkdirSync(path);
  writeFileSync(join(bin,'claude'),'#!/bin/sh\nexec '+JSON.stringify(process.execPath)+' '+JSON.stringify(join(bin,'record.cjs'))+' "$@"\n');chmodSync(join(bin,'claude'),0o700);
  writeFileSync(join(bin,'record.cjs'),"require('fs').writeFileSync(process.env.RELAY_TEST_OUTPUT, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))");
  const env={...process.env,HOME:home,PATH:bin+':'+process.env.PATH,RELAY_TEST_OUTPUT:output,RELAY_TEST_PROJECT:project,RELAY_CLAUDE_PICK_FOLDER:''};
  for(const platform of ['linux','darwin'] as const){
    const direct=spawnSync('sh',['-c',claudeLauncher(platform)],{cwd:project,env,encoding:'utf8'});assert.equal(direct.status,0,direct.stderr);assert.equal(JSON.parse(readFileSync(output,'utf8')).cwd,project);
  }
  writeFileSync(join(bin,'zenity'),'#!/bin/sh\nprintf "%s\\n" "$RELAY_TEST_PROJECT"\n');chmodSync(join(bin,'zenity'),0o700);
  const selected=spawnSync('sh',['-c',claudeLauncher('linux')],{cwd:home,env,encoding:'utf8'});assert.equal(selected.status,0,selected.stderr);assert.equal(JSON.parse(readFileSync(output,'utf8')).cwd,project);
  writeFileSync(output,'not launched');writeFileSync(join(bin,'zenity'),'#!/bin/sh\nexit 1\n');
  const cancelled=spawnSync('sh',['-c',claudeLauncher('linux')],{cwd:home,env,encoding:'utf8'});assert.equal(cancelled.status,0,cancelled.stderr);assert.equal(readFileSync(output,'utf8'),'not launched');
});

test('remote setup browser exposes a guarded one-click launch and repeats no installation or launch',async t=>{
  const {dir}=temporary(t);let installs=0,launches=0;
  const server=await startSetupWeb({dir,remote:true},'fixture',async()=>{installs++;return {dir,cli:'fixture',providers:['claude'],remote:true,launcher:'local-launcher',roomURL:'https://relay.example/app#private'};},async path=>{assert.equal(path,'local-launcher');launches++;});t.after(server.close);
  const url=new URL(server.url),headers={Authorization:'Bearer '+url.hash.slice(1),'Content-Type':'application/json',Origin:url.origin};
  const html=await (await fetch(url.origin)).text();new Function(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)![1]!);
  for(const match of html.matchAll(/el\('([^']+)'\)/g))assert.ok(html.includes(`id="${match[1]}"`),'Missing setup control: '+match[1]);
  assert.match(html,/Open Claude with Relay/);
  assert.equal((await fetch(url.origin+'/api/launch',{method:'POST',headers,body:'{}'})).status,409);
  assert.equal((await fetch(url.origin+'/api/launch',{method:'POST',body:'{}'})).status,403);
  for(let i=0;i<2;i++){
    const response=await fetch(url.origin+'/api/setup',{method:'POST',headers,body:JSON.stringify({name:'Friend',invitation,provider:'claude'})});assert.equal(response.status,200);assert.equal((await response.json() as any).canLaunch,true);
    assert.equal((await fetch(url.origin+'/api/launch',{method:'POST',headers,body:'{}'})).status,200);
  }
  assert.equal(installs,1);assert.equal(launches,1);
});
