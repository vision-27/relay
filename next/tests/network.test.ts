import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { temporary, repository, git, binding, code } from './helpers.js';
import { startHub } from '../node/hub.js';
import { api, Remote } from '../node/client.js';
import { State, saveConnection, publicSession, type Connection } from '../node/state.js';
import { handleHook } from '../node/hooks.js';
import { Connector } from '../node/connector.js';
import { callRelayTool, serveMcp } from '../node/tools.js';
import { workspaceCode, sharedWorkspace, discover } from '../node/network-state.js';
import { changeSharing } from '../node/network-cli.js';
import { installNetwork } from '../node/network-install.js';
import { Room, routeRoom } from '../core/room.js';
import { SQLite } from '../node/sqlite.js';
import { conflicts, context } from '../node/context.js';

const networkTool=(state:State,name:string,args:Record<string,any>)=>callRelayTool(state,name,{...args,session_key:state.binding(args.session_id).sessionKey});

test('network owners invite friends through MCP; ordinary members and other sessions cannot',async t=>{
  const {alice,von,hub,projectId}=await networkPair(t);
  await assert.rejects(callRelayTool(alice.state,'relay_invite',{session_id:alice.session.id,session_key:von.session.sessionKey}),/local session_key/);
  await assert.rejects(networkTool(von.state,'relay_invite',{session_id:von.session.id}),/owner or an admin/);
  const result=await networkTool(alice.state,'relay_invite',{session_id:alice.session.id}) as any;
  assert.equal(result.singleUse,true);
  const invitation=JSON.parse(Buffer.from(result.invitation.slice('relay:network:v1:'.length),'base64url').toString('utf8'));
  assert.equal(invitation.server,hub.url);assert.equal(invitation.projectId,projectId);
  const joined=await api<any>(hub.url,projectId,'','join',{code:invitation.code,name:'New friend',repository:invitation.repository});assert.ok(joined.memberId);
  await assert.rejects(api(hub.url,projectId,'','join',{code:invitation.code,name:'Duplicate',repository:invitation.repository}));
});

async function networkPair(t:test.TestContext,autoCleanup=true){
  const temp=temporary(),aRepo=repository(join(temp.dir,'erp')),bRepo=repository(join(temp.dir,'auth'));
  git(bRepo,'remote','set-url','origin','git@example.invalid:friend/auth.git');
  const key='fixture-network-key',projectId=crypto.randomUUID(),hub=await startHub(join(temp.dir,'hub'),key);
  const created=await api<{token:string;memberId:string}>(hub.url,projectId,key,'create',{name:'Friends',ownerName:'Alice',repository:'network:friends',mode:'network'});
  const invitation=await api<{code:string}>(hub.url,projectId,created.token,'invite',{});
  const joined=await api<{token:string;memberId:string}>(hub.url,projectId,'','join',{code:invitation.code,name:'Von',repository:'unrelated-workspace'});
  const deliveries:{id:string;workspace?:string}[]=[];
  const make=(user:typeof created,name:string,repo:string,provider:'codex'|'claude')=>{
    const dir=join(temp.dir,name),config:Connection={...user,server:hub.url,projectId,repository:'network:friends',name,repo:dir,mode:'network'};
    saveConnection(dir,config);const state=new State(dir);state.set('mode','network');changeSharing(state,repo,false,true);
    handleHook(repo,provider,{cwd:repo,session_id:crypto.randomUUID(),hook_event_name:'SessionStart'},{},dir);
    const session=state.bindings()[0]!;
    const connector=new Connector(state,new Remote(config),async(binding,event)=>{deliveries.push({id:event.id,workspace:binding.workspace});return {state:'accepted',detail:'Isolated test adapter'};});
    return {state,config,session,connector,repo,dir};
  };
  const alice=make(created,'Alice',aRepo,'codex'),von=make(joined,'Von',bRepo,'claude');
  const cleanup=async()=>{await alice.connector.stop();await von.connector.stop();alice.state.close();von.state.close();await hub.close();temp.cleanup();};
  if(autoCleanup)t.after(cleanup);
  await alice.connector.tick();await von.connector.tick();await alice.connector.tick();
  return {alice,von,hub,key,projectId,deliveries,temp,cleanup};
}

test('different repositories discover each other and exchange source-attributed answers with durable receipts',async t=>{
  const {alice,von,deliveries}=await networkPair(t);
  assert.notEqual(alice.session.git.repository,von.session.git.repository);
  await networkTool(von.state,'relay_presence',{session_id:von.session.id,task:'Authentication and ERP pagination'});
  await von.connector.tick();await alice.connector.tick();
  const found=await networkTool(alice.state,'relay_discover',{session_id:alice.session.id,person:'Von',topic:'pagination'}) as any;
  assert.equal(found.selection,'one_match');assert.equal(found.sessions[0].id,von.session.id);
  const asked=await networkTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:found.sessions[0].id,question:'How did you paginate the ERP API?'}) as any;
  // The question is durable locally before the service is contacted.
  const reopened=new State(alice.dir);assert.equal(reopened.pending()[0]?.id,asked.eventId);reopened.close();
  await alice.connector.tick();await von.connector.tick();await von.connector.tick();await alice.connector.tick();
  assert.equal(deliveries.length,1);assert.equal(deliveries[0]?.workspace,von.repo);
  assert.equal((alice.state.get<any>('snapshot')).receipts.find((r:any)=>r.eventId===asked.eventId).state,'accepted');
  await networkTool(von.state,'relay_reply',{session_id:von.session.id,question_id:asked.eventId,answer:'Use the returned cursor until there is no next page.'});
  await von.connector.tick();await alice.connector.tick();await alice.connector.tick();
  const reply=alice.state.events().find(e=>e.replyTo===asked.eventId)!;
  assert.equal(reply.git.repository,von.session.git.repository);assert.equal(reply.targetSessionId,alice.session.id);
  assert.equal((alice.state.get<any>('snapshot')).receipts.find((r:any)=>r.eventId===asked.eventId).state,'answered');
  assert.match(context(alice.state,alice.session.id,'',true).text,/returned cursor/);
  assert.equal(deliveries.length,2,'Repeated ticks must not duplicate the question or reply');
});

test('global hooks obey sharing policy and never capture prompts, transcripts, or final assistant text',async t=>{
  const {alice,temp}=await networkPair(t),privateDir=join(temp.dir,'private');mkdirSync(privateDir);
  const source=crypto.randomUUID();
  assert.deepEqual(handleHook(privateDir,'codex',{cwd:privateDir,session_id:source,hook_event_name:'SessionStart'},{},alice.dir),{});
  assert.equal(alice.state.bindings().length,1);
  changeSharing(alice.state,undefined,true,true);
  handleHook(privateDir,'codex',{cwd:privateDir,session_id:source,hook_event_name:'UserPromptSubmit',prompt:'private raw prompt',transcript_path:'sensitive.jsonl'},{},alice.dir);
  handleHook(privateDir,'codex',{cwd:privateDir,session_id:source,hook_event_name:'Stop',last_assistant_message:'private final text'},{},alice.dir);
  const session=alice.state.bindings().find(s=>s.sourceId===source)!;
  assert.equal(session.task,'');assert.equal(session.transcriptPath,undefined);assert.equal(alice.state.pending().length,0);
  assert.equal(JSON.stringify(publicSession(session)).includes(privateDir),false);
  changeSharing(alice.state,privateDir,false,false);
  assert.equal(alice.state.binding(session.id).state,'closed');assert.equal(sharedWorkspace(alice.state,privateDir),undefined);
  await assert.rejects(networkTool(alice.state,'relay_ask',{session_id:session.id}),/no longer shared/);
  await alice.connector.tick();
  assert.equal(alice.state.get<any>('snapshot').sessions.find((s:any)=>s.id===session.id).state,'closed');
});

test('network service preserves repository mode isolation, source ownership, revocation and restricted operations',async t=>{
  const db=new SQLite(':memory:');t.after(()=>db.close());const room=new Room(db);
  const a=await room.create('Network','Alice','network:test','network'),owner=await room.authenticate(a.token);
  const invitation=await room.invite(owner),b=await room.join(invitation.code,'Von','different/repository'),peer=await room.authenticate(b.token);
  const sa=binding(owner.id,'codex'),sb=binding(peer.id,'claude',crypto.randomUUID(),{...code,repository:'friend/repository'});
  room.register(owner,sa);room.register(peer,sb);
  const question={id:crypto.randomUUID(),sessionId:sa.id,kind:'question' as const,text:'Question',paths:[],targetSessionId:sb.id};
  await room.append(owner,question);
  await assert.rejects(room.append(owner,{...question,id:crypto.randomUUID(),git:{...sb.git,repository:''}}),/source code metadata/);
  await assert.rejects(room.append(peer,{id:crypto.randomUUID(),sessionId:sb.id,kind:'observation',text:'Unrequested transcript',paths:[]}),/directed questions/);
  await assert.rejects(room.append(owner,{id:crypto.randomUUID(),sessionId:sa.id,kind:'reply',text:'spoof',paths:[],replyTo:question.id,targetSessionId:sa.id}),/addressed session/);
  for(const action of ['tasks','artifacts','integrations','taskarchive'])assert.equal((await routeRoom(room,new Request('http://local/'+action,{method:'POST',headers:{Authorization:'Bearer '+a.token},body:'{}'}),action)).status,403);
  room.revoke(owner,peer.id);await assert.rejects(room.append(owner,{...question,id:crypto.randomUUID()}),/revoked/);
});

test('workspace changes retain queued provenance and entering a private folder closes the registration',async t=>{
  const {alice,von,temp}=await networkPair(t),other=repository(join(temp.dir,'other')),privateDir=join(temp.dir,'private-cwd');mkdirSync(privateDir);
  git(other,'remote','set-url','origin','https://example.invalid/another/repo.git');changeSharing(alice.state,other,false,true);
  const asked=await networkTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:von.session.id,question:'Queued from the original repository'}) as any;
  handleHook(other,'codex',{cwd:other,session_id:alice.session.sourceId,hook_event_name:'PreToolUse'},{},alice.dir);
  await alice.connector.tick();assert.equal(alice.state.event(asked.eventId)?.git.repository,alice.session.git.repository);
  assert.equal(alice.state.binding(alice.session.id).git.repository,'example.invalid/another/repo');
  handleHook(privateDir,'codex',{cwd:privateDir,session_id:alice.session.sourceId,hook_event_name:'PreToolUse'},{},alice.dir);
  assert.equal(alice.state.binding(alice.session.id).state,'closed');
  await assert.rejects(networkTool(alice.state,'relay_context',{session_id:alice.session.id}),/no longer shared/);
});

test('discovery exposes ambiguous matches and stale activity without conflating repositories',t=>{
  const temp=temporary(),state=new State(join(temp.dir,'state'));t.after(()=>{state.close();temp.cleanup();});
  const a=binding('friend','claude'),b={...binding('friend','codex'),git:{...code,repository:'other/repo'}},stale={...binding('friend','codex'),updatedAt:new Date(Date.now()-300_000).toISOString()};
  state.set('snapshot',{sessions:[a,b,stale],members:[{id:'friend',name:'Von'}]});
  const results=discover(state,'me',{person:'von',topic:'authentication'});
  assert.equal(results.selection,'choose_session');assert.equal(results.total,3);
  assert.equal(discover(state,'me',{person:'von',active_only:true}).total,2);
  assert.deepEqual(conflicts([a,b]),[]);
});

test('global installer preserves user settings, keeps repository integration, and is repeatable',t=>{
  const {dir}=temporary(t),userHome=join(dir,'home'),codexHome=join(userHome,'.codex'),claudeHome=join(userHome,'.claude'),network=join(userHome,'.relay/network');
  mkdirSync(codexHome,{recursive:true});mkdirSync(claudeHome,{recursive:true});
  writeFileSync(join(codexHome,'config.toml'),'model = "existing"\n[mcp_servers.existing]\ncommand = "existing-tool"\n');
  writeFileSync(join(claudeHome,'settings.json'),JSON.stringify({permissions:{allow:['Read']},hooks:{Stop:[{hooks:[{command:'echo existing'}]}]}}));
  writeFileSync(join(userHome,'.claude.json'),JSON.stringify({projects:{existing:{keep:true}},mcpServers:{relay_next:{command:'existing'}}}));
  const cli=resolve('out/node/cli.js');
  for(let i=0;i<2;i++)for(const provider of ['codex','claude'] as const)installNetwork(provider,cli,network,userHome,process.execPath,codexHome,claudeHome);
  const settings=JSON.parse(readFileSync(join(claudeHome,'settings.json'),'utf8'));
  assert.deepEqual(settings.permissions.allow,['Read']);assert.equal(settings.hooks.Stop.length,2);
  const mcp=JSON.parse(readFileSync(join(userHome,'.claude.json'),'utf8'));
  assert.equal(mcp.projects.existing.keep,true);assert.equal(mcp.mcpServers.relay_next.command,'existing');
  assert.ok(mcp.mcpServers.relay_network.args.includes('--global'));assert.ok(!mcp.mcpServers.relay_network.args.includes('--repo'));
  const codex=readFileSync(join(codexHome,'config.toml'),'utf8');assert.match(codex,/model = "existing"/);assert.equal((codex.match(/\[mcp_servers.relay_network\]/g)??[]).length,1);
  assert.ok(existsSync(join(network,'config-backups')));
});

test('global installer rejects collisions before writes and rejects symlinked configuration roots',t=>{
  const {dir}=temporary(t),userHome=join(dir,'home'),codexHome=join(userHome,'.codex'),claudeHome=join(userHome,'.claude');mkdirSync(codexHome,{recursive:true});
  const config='[mcp_servers."relay_network"]\ncommand = "other-tool"\n';writeFileSync(join(codexHome,'config.toml'),config);
  assert.throws(()=>installNetwork('codex',resolve('out/node/cli.js'),join(dir,'network'),userHome,process.execPath,codexHome,claudeHome),/needs review/);
  assert.equal(existsSync(join(codexHome,'hooks.json')),false);assert.equal(readFileSync(join(codexHome,'config.toml'),'utf8'),config);
  const linked=join(dir,'linked');symlinkSync(codexHome,linked,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>installNetwork('codex',resolve('out/node/cli.js'),join(dir,'network'),userHome,process.execPath,linked,claudeHome),/symlink/);
});

test('network MCP exposes discovery and messaging, and rejects repository operations even if called directly',async t=>{
  const {alice}=await networkPair(t),input=new PassThrough(),output=new PassThrough();let response='';output.on('data',chunk=>response+=chunk);
  const serving=serveMcp(alice.state,input,output);
  input.end([ {jsonrpc:'2.0',id:1,method:'initialize'}, {jsonrpc:'2.0',id:2,method:'tools/list'}, {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'relay_artifact',arguments:{session_id:alice.session.id}}} ].map(r=>JSON.stringify(r)).join('\n')+'\n');
  await serving;const replies=response.trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(replies[0].result.serverInfo.name,'relay-network');
  const names=replies[1].result.tools.map((tool:any)=>tool.name);assert.ok(names.includes('relay_discover'));assert.ok(!names.includes('relay_artifact'));
  assert.equal(replies[2].result.isError,true);
});

test('network sessions require their own local key, and keys never enter public session metadata or shared text',async t=>{
  const {alice,von}=await networkPair(t);
  await assert.rejects(callRelayTool(alice.state,'relay_discover',{session_id:alice.session.id}),/local session_key/);
  await assert.rejects(callRelayTool(alice.state,'relay_discover',{session_id:alice.session.id,session_key:von.session.sessionKey}),/local session_key/);
  assert.equal(JSON.stringify(publicSession(alice.session)).includes(alice.session.sessionKey!),false);
  const question=await networkTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:von.session.id,question:'Do not disclose '+alice.session.sessionKey}) as any;
  await alice.connector.tick();assert.match(alice.state.event(question.eventId)!.text,/REDACTED SESSION KEY/);
  assert.equal(JSON.stringify(alice.state.get('snapshot')).includes(alice.session.sessionKey!),false);
});

test('stale network sessions do not permanently consume the active-session limit',async t=>{
  const db=new SQLite(':memory:');t.after(()=>db.close());const room=new Room(db);
  const created=await room.create('Network','Alice','network:capacity','network'),owner=await room.authenticate(created.token);
  for(let i=0;i<70;i++)room.register(owner,{...binding(owner.id,'codex'),updatedAt:new Date(Date.now()-300_000).toISOString()});
  for(let i=0;i<64;i++)room.register(owner,binding(owner.id,'codex'));
  assert.throws(()=>room.register(owner,binding(owner.id,'codex')),/active-session limit/);
});

test('network presence strips remote credentials and local paths',t=>{
  const {dir}=temporary(t),repo=repository(join(dir,'repo'));
  git(repo,'remote','set-url','origin','https://username:secret@example.invalid/team/repo.git?token=secret');
  assert.equal(workspaceCode(repo).repository,'example.invalid/team/repo');
  git(repo,'remote','set-url','origin','file:///private/source/repo');assert.match(workspaceCode(repo).repository,/^local:/);
});

function cli(args:string[],cwd:string,input?:string){
  return new Promise<{code:number|null;output:string}>((done,reject)=>{
    const child=spawn(process.execPath,[resolve('out/node/cli.js'),...args],{cwd,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,RELAY_CREATE_KEY:undefined}});
    let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('CLI deadline: '+output));},10000);
    child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);done({code,output});});
    child.stdin.end(input??'');
  });
}
test('global onboarding works outside Git and joins a friend without repository matching',async t=>{
  const {hub,key,temp}=await networkPair(t),first=join(temp.dir,'cli-first'),second=join(temp.dir,'cli-second');
  const connected=await cli(['connect','--global','--dir',first,'--server',hub.url,'--create-key',key,'--name','First','--no-start','--no-install','--all-workspaces'],temp.dir);
  assert.equal(connected.code,0,connected.output);
  const invitation=await cli(['invite','--global','--dir',first],temp.dir);assert.equal(invitation.code,0,invitation.output);
  const invite=invitation.output.match(/relay:network:v1:[A-Za-z0-9_-]+/)?.[0];assert.ok(invite);
  const joined=await cli(['connect','--global','--dir',second,'--invite',invite,'--name','Friend','--no-start','--no-install'],temp.dir);
  assert.equal(joined.code,0,joined.output);
  assert.equal(JSON.parse(readFileSync(join(second,'connection.json'),'utf8')).mode,'network');
  const status=await cli(['status','--global','--dir',second],temp.dir);assert.equal(status.code,0,status.output);assert.match(status.output,/"mode": "network"/);
});

test('global MCP starts one shared connector, respects an explicit stop, and resumes through connect',async t=>{
  const {alice,temp,cleanup}=await networkPair(t,false),lock=join(alice.dir,'connector.lock'),stop=join(alice.dir,'stop');
  const waitFor=async(check:()=>boolean)=>{const deadline=Date.now()+7000;while(!check()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));assert.ok(check(),'Connector lifecycle deadline');};
  t.after(async()=>{try{writeFileSync(stop,'fixture cleanup');await waitFor(()=>!existsSync(lock));}finally{await cleanup();}});
  writeFileSync(stop,'stopped');
  const init=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n';
  const stopped=await cli(['mcp','--global','--dir',alice.dir],temp.dir,init);
  assert.equal(stopped.code,0,stopped.output);assert.match(stopped.output,/relay-network/);assert.equal(existsSync(lock),false);
  const resumed=await cli(['connect','--global','--dir',alice.dir,'--no-install'],temp.dir);assert.equal(resumed.code,0,resumed.output);
  await waitFor(()=>existsSync(lock));const first=JSON.parse(readFileSync(lock,'utf8')).pid;
  await cli(['mcp','--global','--dir',alice.dir],temp.dir,init);assert.equal(JSON.parse(readFileSync(lock,'utf8')).pid,first);
  const stopping=await cli(['stop','--global','--dir',alice.dir],temp.dir);assert.equal(stopping.code,0,stopping.output);await waitFor(()=>!existsSync(lock));
});
