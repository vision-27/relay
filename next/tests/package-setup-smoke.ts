import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { temporary } from './helpers.js';
import { startHub } from '../node/hub.js';
import { api } from '../node/client.js';
import { loadConnection } from '../node/state.js';
import { VERSION } from '../core/version.js';

const npmCli=process.env.npm_execpath;
if(!npmCli)throw new Error('Run through npm run test:package-setup');
const temp=temporary(),hub=await startHub(join(temp.dir,'hub'),'package-fixture-key');
const env={...process.env,RELAY_CREATE_KEY:undefined,RELAY_SERVER_URL:undefined,
  npm_config_cache:join(temp.dir,'fresh npm cache'),
  CODEX_HOME:join(temp.dir,'Codex config'),CLAUDE_CONFIG_DIR:join(temp.dir,'Claude config')};
const npm=(args:string[],cwd:string)=>promisify(execFile)(process.execPath,[npmCli,...args],{cwd,env,windowsHide:true,timeout:60000,maxBuffer:2_000_000});
try {
  const packed=JSON.parse((await npm(['pack','--ignore-scripts','--json','--pack-destination',temp.dir],process.cwd())).stdout)[0];
  assert.ok(packed.files.every((file:{path:string})=>file.path==='package.json'||/^out\/(core|node)\//.test(file.path)||/^(next\/[^/]+\.md|README.md|LICENSE)$/.test(file.path)),'Package contains only the published file allowlist');
  const install=join(temp.dir,'package install');mkdirSync(install);
  // A clean machine must be allowed to fetch runtime dependencies. npm ci caches
  // locked tarballs, but does not guarantee package metadata for an offline install.
  await npm(['install','--prefix',install,'--ignore-scripts','--no-audit','--no-fund',join(temp.dir,packed.filename)],install);
  const version=await npm(['exec','--offline','--','relay','--version'],install);assert.equal(version.stdout.trim(),VERSION);
  const projectId=crypto.randomUUID(),repository='network:'+projectId;
  const owner=await api<{token:string}>(hub.url,projectId,'package-fixture-key','create',{name:'Package test',ownerName:'Owner',repository,mode:'network'});
  const invite=await api<{code:string}>(hub.url,projectId,owner.token,'invite',{});
  const invitation='relay:network:v1:'+Buffer.from(JSON.stringify({server:hub.url,projectId,repository,code:invite.code})).toString('base64url');
  mkdirSync(env.CODEX_HOME);mkdirSync(env.CLAUDE_CONFIG_DIR);
  const network=join(temp.dir,'Network state');
  const setup=await npm(['exec','--offline','--','relay','setup','--dir',network,'--invite',invitation,'--name','Package fixture','--no-start'],install);
  assert.match(setup.stdout,/configured for Codex \+ Claude Code/);assert.equal(loadConnection(network).name,'Package fixture');
  const claude=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'.claude.json'),'utf8'));
  const installed=claude.mcpServers.relay_network.args[0];assert.ok(installed.startsWith(resolve(network)));
  writeFileSync(join(network,'stop'),'fixture');
  const runtime=await promisify(execFile)(process.execPath,[installed,'--version'],{env,windowsHide:true,timeout:10000});assert.equal(runtime.stdout.trim(),VERSION);
  console.log(JSON.stringify({version:VERSION,platform:process.platform,packageFiles:packed.files.length,installedAlias:'relay',setup:'passed',clients:['codex','claude'],runtime:'persistent',modelCalls:0}));
}finally{await hub.close();temp.cleanup();}
