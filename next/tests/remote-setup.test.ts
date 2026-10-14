import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { temporary } from './helpers.js';
import { claudeLauncher, parseRemoteInvitation, setupRemote, useRemoteSetup } from '../node/remote-setup.js';
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
