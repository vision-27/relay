// Opt-in native Claude QA: uses the current login, an isolated local Worker, and a $0.50 model budget.
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {temporary} from '../../out/tests/helpers.js';
import {mergeClaudeSessionHooks} from '../../out/core/claude-hooks.js';
import {ClaudeSessions} from '../../out/node/claude-session.js';
import {ClientBudget} from '../../out/node/request-budget.js';
const temp=temporary(),portServer=createServer();
await new Promise(done=>portServer.listen(0,'127.0.0.1',done));
const port=portServer.address().port;await new Promise(done=>portServer.close(done));
const server='http://127.0.0.1:'+port,project=crypto.randomUUID(),operator='native-test-only';
const worker=spawn(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'dev','--local','--config','next/worker/wrangler.jsonc','--ip','127.0.0.1','--port',String(port),'--persist-to',join(temp.dir,'worker'),'--var','RELAY_CREATE_KEY:'+operator],{windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
let workerLog='';for(const stream of [worker.stdout,worker.stderr])stream.on('data',chunk=>{workerLog=(workerLog+chunk).slice(-2200);});let claude,stderr='',events=[];
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const until=async(fn,timeout=45000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await wait(300);}throw Error('Native verification timed out');};
const post=async(route,token,body)=>{const r=await fetch(server+'/projects/'+project+'/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Fixture HTTP '+r.status);return r.json();};
const report={modelCalls:true,ordinaryClaude:true,channelFlags:false,workspaceSelection:false,registered:false,initialResponse:false,idleReply:false,busyReply:false};
try{
 await until(async()=>{try{return[200,429].includes((await fetch(server+'/health',{signal:AbortSignal.timeout(1000)})).status);}catch{return false;}},45000);
 const initialized=await fetch(server+'/budget/initialize',{method:'POST',headers:{Authorization:'Bearer '+operator,'Content-Type':'application/json'},body:JSON.stringify({billingAnchor:new Date().toISOString(),initialUsage:0})});if(!initialized.ok)throw Error('Fixture budget initialization failed');
 const owner=await post('create',operator,{name:'Native hooks QA',ownerName:'Fixture',repository:'network:'+project,mode:'network'});
 const config={server,projectId:project,token:owner.token},connection=join(temp.dir,'connection.json'),settings=join(temp.dir,'settings.json'),mcp=join(temp.dir,'mcp.json'),cwd=join(temp.dir,'Unrelated work folder');mkdirSync(cwd);
 writeFileSync(connection,JSON.stringify(config),{mode:0o600});
 writeFileSync(settings,JSON.stringify(mergeClaudeSessionHooks({},process.execPath,resolve('out/node/claude-session-hook.js'),connection)));
 writeFileSync(mcp,JSON.stringify({mcpServers:{relay_remote:{type:'stdio',command:process.execPath,args:[resolve('out/node/claude-session-mcp.js'),connection]}}}));
 const nativeId=crypto.randomUUID(),store=new ClaudeSessions(config,connection,new ClientBudget(join(temp.dir,'budget.sqlite')));
 const exe=process.platform==='win32'?execFileSync('where.exe',['claude.exe'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0]:'claude';
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('WMUX_')&&!key.startsWith('CMUX_')&&!['CLAUDECODE','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDE_PID'].includes(key)));
 claude=spawn(exe,['-p','--debug-file',resolve('.relay/session-native-debug.log'),'--input-format','stream-json','--output-format','stream-json','--verbose','--model','haiku','--max-budget-usd','0.50','--tools','','--session-id',nativeId,'--setting-sources','','--settings',settings,'--strict-mcp-config','--mcp-config',mcp,'--allowedTools','mcp__relay_remote__relay_check','mcp__relay_remote__relay_reply','mcp__relay_remote__relay_ack'],{cwd,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],env});
 let output='',results=0,busyFinished=false;
 claude.stdout.on('data',chunk=>{output+=chunk;for(let i;(i=output.indexOf('\n'))>=0;){const line=output.slice(0,i);output=output.slice(i+1);try{const x=JSON.parse(line);events.push({type:x.type,subtype:x.subtype,...(x.type==='result'?{is_error:x.is_error,errors:x.errors,result:x.result}:{})});if(x.type==='assistant'&&x.message?.content?.some(c=>c.type==='text'&&c.text.includes('RELAY_BUSY_FINISHED')))busyFinished=true;if(x.type==='result')results++;}catch{}}});
 claude.stderr.on('data',chunk=>{stderr+=chunk;});
 claude.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'This is an isolated Relay integration test. Reply READY now. When Relay supplies a pending question, use your own Relay session key to check it and reply through relay_reply with the requested test marker. Do not read files or run commands.'}})+'\n');
 await until(()=>!!store.read(nativeId),60000);report.registered=true;
 await until(()=>results>=1||claude.exitCode!==null,60000);if(claude.exitCode!==null)throw Error('Claude exited before idle verification');report.initialResponse=true;
 const state=store.read(nativeId);await until(()=>store.read(nativeId)?.mode==='idle',15000);
 const question=crypto.randomUUID();await post('dashboard',owner.token,{operation:'send',targetSessionId:state.session_id,requestId:question,text:'Integration test: reply with RELAY_NATIVE_IDLE_OK using relay_reply.'});
 await until(async()=>{const data=await post('dashboard',owner.token,{operation:'read',after:0});return data.events.some(e=>e.replyTo===question&&e.text.includes('RELAY_NATIVE_IDLE_OK'));},60000);report.idleReply=true;
 await until(()=>store.read(nativeId)?.mode==='idle',15000);
 claude.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'For the next integration check, count from 1 through 80 separated by spaces, then say RELAY_BUSY_FINISHED. Do not call Relay tools during this response; finish this task first.'}})+'\n');
 await until(()=>store.read(nativeId)?.mode==='busy',15000);
 const busyQuestion=crypto.randomUUID();await post('dashboard',owner.token,{operation:'send',targetSessionId:state.session_id,requestId:busyQuestion,text:'After finishing your current work, reply RELAY_NATIVE_BUSY_OK using relay_reply.'});
 await until(async()=>{const data=await post('dashboard',owner.token,{operation:'read',after:0});return data.events.some(e=>e.replyTo===busyQuestion&&e.text.includes('RELAY_NATIVE_BUSY_OK'));},60000);
 if(!busyFinished)throw Error('The current task did not finish before the queued reply');report.busyReply=true;
 console.log(JSON.stringify(report));
}catch(error){console.log(JSON.stringify({...report,error:error.message,exit:claude?.exitCode,eventTypes:events.map(e=>e.type)}));process.exitCode=1;}
finally{
 for(const child of [claude,worker])if(child&&child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,detached:process.platform!=='win32',stdio:'ignore'});}catch{child.kill();}}
 await wait(1000);writeFileSync(resolve('.relay/session-native-result.json'),JSON.stringify(report));
 try{temp.cleanup();}catch{}
}
