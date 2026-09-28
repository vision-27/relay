import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { install } from '../node/install.js';
import { handleHook } from '../node/hooks.js';
import { claudeDelivery } from '../node/adapters.js';
import { terminalStatus } from '../node/terminal.js';
import { State, stateDir, publicSession } from '../node/state.js';
import { serveMcp } from '../node/tools.js';
import { serverURL, api, HttpError } from '../node/client.js';
import { context } from '../node/context.js';
import { temporary, repository, pair, binding, code } from './helpers.js';
import type { RelayEvent } from '../core/types.js';
test('hook installation preserves unrelated settings and repeated installs do not duplicate',t=>{
  const {dir}=temporary(t),repo=repository(join(dir,'repo with spaces'));mkdirSync(join(repo,'.claude'));
  writeFileSync(join(repo,'.claude/settings.local.json'),JSON.stringify({permissions:{allow:['Read']},hooks:{Stop:[{hooks:[{type:'command',command:'echo existing'}]}]}}));
  const cli=resolve('out/node/cli.js');install(repo,'claude',cli);install(repo,'claude',cli);install(repo,'codex',cli);install(repo,'codex',cli);
  const claude=JSON.parse(readFileSync(join(repo,'.claude/settings.local.json'),'utf8'));
  assert.deepEqual(claude.permissions.allow,['Read']);assert.equal(claude.hooks.Stop.length,2);
  assert.equal((readFileSync(join(repo,'.codex/config.toml'),'utf8').match(/\[mcp_servers.relay_next\]/g)??[]).length,1);
  assert.match(readFileSync(join(repo,'.gitignore'),'utf8'),/\.relay\//);
});
test('installation rejects an MCP name collision before changing existing hooks',t=>{
  const {dir}=temporary(t),repo=repository(join(dir,'repo'));mkdirSync(join(repo,'.claude'));
  const settings=JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'echo preserve-me'}]}]}});
  const mcp=JSON.stringify({mcpServers:{relay_next:{command:'another-program',args:[]}}});
  writeFileSync(join(repo,'.claude/settings.local.json'),settings);writeFileSync(join(repo,'.mcp.json'),mcp);
  assert.throws(()=>install(repo,'claude',resolve('out/node/cli.js')),/needs review/);
  assert.equal(readFileSync(join(repo,'.claude/settings.local.json'),'utf8'),settings);
  assert.equal(readFileSync(join(repo,'.mcp.json'),'utf8'),mcp);
});
test('foreground connector resumes after a previous stop and exits on a fresh stop request',async t=>{
  const fixture=await pair(),{alice}=fixture;writeFileSync(join(stateDir(alice.repo),'stop'),'old stop');
  const child=spawn(process.execPath,[resolve('out/node/cli.js'),'run','--repo',alice.repo],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',closed=false;child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
  child.on('error',error=>{output+=error.message;});
  const exited=new Promise<number|null>(r=>child.once('close',code=>{closed=true;r(code);}));
  t.after(async()=>{if(!closed){child.kill();await exited;}await fixture.cleanup();});
  const deadline=Date.now()+5000;
  while(!output.includes('Relay connector running')&&!closed&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
  assert.match(output,/Relay connector running/);await new Promise(r=>setTimeout(r,1200));assert.equal(closed,false,output);
  writeFileSync(join(stateDir(alice.repo),'stop'),'new stop');
  let timeout:NodeJS.Timeout;const code=await Promise.race([exited,new Promise<number>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Connector did not stop')),5000);})]).finally(()=>clearTimeout(timeout));
  assert.equal(code,0,output);
});
test('hooks register only the selected repository and expose no native credentials remotely',async t=>{
  const {alice}=await pair(t),source=crypto.randomUUID();
  const result=handleHook(alice.repo,'claude',{cwd:alice.repo,session_id:source,hook_event_name:'SessionStart'}, {CLAUDE_CODE_MESSAGING_SOCKET:'test-pipe',CLAUDE_CODE_MESSAGING_TOKEN:'local-only-secret',WMUX_SURFACE_ID:'test-surface'});
  assert.match(JSON.stringify(result),/relay session_id/);
  const created=alice.state.bindings().find(b=>b.sourceId===source)!;assert.equal(created.endpoint,'test-pipe');
  assert.equal(JSON.stringify(publicSession(created)).includes('local-only-secret'),false);
  assert.deepEqual(handleHook(alice.repo,'codex',{cwd:join(alice.repo,'other'),session_id:crypto.randomUUID(),hook_event_name:'SessionStart'}),{});
  assert.equal(alice.state.bindings().length,2);
});
test('stop captures visible assistant evidence with a source label and removes credential patterns',async t=>{
  const {alice}=await pair(t),source=crypto.randomUUID();
  handleHook(alice.repo,'codex',{cwd:alice.repo,session_id:source,hook_event_name:'Stop',last_assistant_message:'Login contract uses cookies. api_key=secret123'});
  const job=alice.state.pending().find(j=>j.action==='events')!;
  assert.match(JSON.stringify(job.body),/Observed final assistant text/);assert.match(JSON.stringify(job.body),/REDACTED/);
  assert.equal(JSON.stringify(job.body).includes('secret123'),false);
});
test('Claude adapter uses the captured local auth token and exact session id, and only claims acceptance',async t=>{
  const {dir}=temporary(t),endpoint=process.platform==='win32'?`\\\\.\\pipe\\relay-next-test-${crypto.randomUUID()}`:join(dir,'inbox.sock');
  let payload='';const server=createServer(socket=>{socket.on('data',data=>payload+=data);socket.on('end',()=>socket.end());});
  await new Promise<void>(r=>server.listen(endpoint,r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const target={...binding('member','claude'),endpoint,inboxToken:'local-secret'};
  const event:RelayEvent={id:crypto.randomUUID(),sessionId:'sender',memberId:'other',targetSessionId:target.id,kind:'question',text:'What changed?',paths:[],git:code,createdAt:new Date().toISOString(),seq:1};
  const result=await claudeDelivery(target,event);await new Promise(r=>setTimeout(r,20));
  const [auth,message]=payload.trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(auth.token,'local-secret');assert.equal(message.session_id,target.sourceId);assert.equal(message.msg_id,event.id);assert.equal(result.state,'accepted');
});
test('terminal decoration uses the recorded target and does not touch an unidentified pane',async t=>{
  const {dir}=temporary(t),endpoint=process.platform==='win32'?`\\\\.\\pipe\\relay-terminal-test-${crypto.randomUUID()}`:join(dir,'terminal.sock');
  const requests:string[]=[];
  const server=createServer(socket=>{let line='';socket.on('data',data=>{line+=data;if(line.includes('\n')){requests.push(line.trim());socket.end('{"ok":true}\n');}});});
  await new Promise<void>(r=>server.listen(endpoint,r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const target={...binding('member','codex'),terminal:{kind:'wmux' as const,socket:endpoint,workspace:'workspace-1',surface:'surface-2',token:'fixture-only'}};
  assert.equal(await terminalStatus({...target,terminal:{...target.terminal,workspace:undefined}},'online'),false);
  assert.equal(requests.length,0);assert.equal(await terminalStatus(target,'online'),true);
  const request=JSON.parse(requests[0]!);assert.equal(request.method,'sidebar.set_status');assert.equal(request.token,'fixture-only');
  assert.deepEqual(request.params,{key:'relay_next',value:'online',caller:'surface-2',workspaceId:'workspace-1'});
  assert.equal(await terminalStatus({...target,terminal:{...target.terminal,kind:'cmux'}},'offline'),true);
  assert.equal(requests[1],'set_status relay_next offline --tab=workspace-1');
});
test('MCP framing keeps JSON-RPC output clean and reports tool validation errors',async t=>{
  const {alice}=await pair(t),input=new PassThrough(),output=new PassThrough();let response='';output.on('data',data=>response+=data);
  const serving=serveMcp(alice.state,input,output);
  input.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'relay_reply',arguments:{session_id:alice.session.id,question_id:'missing',answer:'no'}}})+'\n');
  await serving;const replies=response.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies[0].result.serverInfo.name,'relay-next');assert.equal(replies[1].result.isError,true);
});
test('remote connections require HTTPS and never accept embedded credentials',()=>{
  assert.throws(()=>serverURL('http://public.example'),/HTTPS/);assert.throws(()=>serverURL('https://user:password@example.com'),/credentials/);assert.equal(serverURL('http://127.0.0.1:7337/'),'http://127.0.0.1:7337');
});
test('non-JSON authorization errors preserve their HTTP status',async t=>{
  const {alice}=await pair(t);
  await assert.rejects(api(alice.config.server,crypto.randomUUID(),'','create',{}),(error:unknown)=>error instanceof HttpError&&error.status===401);
});
test('old evidence remains searchable and replay cannot resurrect a superseded decision',t=>{
  const temp=temporary(),state=new State(join(temp.dir,'state'));t.after(()=>{state.close();temp.cleanup();});const session=binding('me','codex');state.bind(session);
  const events:RelayEvent[]=Array.from({length:2300},(_,i)=>({id:`event-${i}`,seq:i+1,memberId:'peer',sessionId:'peer-session',kind:i<2?'decision':'observation',text:i===0?'obsolete wombat interface':i===1?'New interface':'activity',paths:[],git:code,createdAt:new Date().toISOString(),...(i===1?{supersedes:'event-0'}:{})}));
  state.cache(events);state.cache([events[0]!]);assert.equal(state.search('wombat').length,1);
  const pack=context(state,session.id,'wombat',true);assert.equal(pack.events.some(e=>e.id==='event-0'),false);assert.ok(state.decisions().some(e=>e.id==='event-1'));
});
