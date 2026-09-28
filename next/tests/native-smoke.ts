// Opt-in only: starts one disposable Claude Code process under the current login.
// Budget is enforced by Claude's --max-budget-usd, and wall time by this runner.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { pair } from './helpers.js';
import { install } from '../node/install.js';
import { Connector } from '../node/connector.js';
import { Remote } from '../node/client.js';
import { nativeDelivery } from '../node/adapters.js';
import { callTool } from '../node/tools.js';
import { redact } from '../core/types.js';
const fixture=await pair();
const {alice,bob}=fixture,sourceId=crypto.randomUUID();
install(bob.repo,'claude',resolve('out/node/cli.js'));
const native=new Connector(bob.state,new Remote(bob.config),nativeDelivery(bob.repo));
let finished=false,initial=false,tail='',cost=0,phase='provider startup';
console.log('Native test: starting one disposable Claude session; model budget $0.50, deadline 90 seconds.');
const child=spawn('claude',[
  '-p','--input-format','stream-json','--output-format','stream-json','--verbose',
  '--session-id',sourceId,'--max-budget-usd','0.50','--model','haiku','--tools','',
  '--setting-sources','','--settings',join(bob.repo,'.claude/settings.local.json'),
  '--strict-mcp-config','--mcp-config',join(bob.repo,'.mcp.json'),
  '--allowedTools','mcp__relay_next__relay_ack','mcp__relay_next__relay_reply','mcp__relay_next__relay_context',
  '--system-prompt','You are a disposable Relay integration test in an empty fixture repository. Reply READY to the first prompt. When a Relay question arrives, acknowledge it with relay_ack and answer it with relay_reply, using exactly the answer RELAY_NATIVE_OK. Use the session_id supplied by Relay hooks. Do not edit files, publish observations yourself, ask follow-up questions, or use any other tools.'
],{cwd:bob.repo,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('WMUX_')&&!key.startsWith('CMUX_')&&!['CLAUDECODE','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDE_PID'].includes(key)))});
child.on('error',error=>{tail=error.message;finished=true;});child.on('exit',()=>{finished=true;});
child.stderr.on('data',data=>{tail=(tail+data).slice(-1500);});
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{try{const event=JSON.parse(line);if(event.type==='system'&&event.subtype==='init')console.log('Native test: provider initialized.');if(event.type==='result'){initial=true;cost=event.total_cost_usd??cost;console.log(`Native test: provider result (${event.subtype??'complete'}); reported cost $${cost.toFixed(4)}.`);if(event.is_error)tail=String(event.result??event.errors??'Claude returned an error');}}catch{/* non-JSON diagnostic */}});
child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'Reply READY and await the Relay message.'}})+'\n');
const deadline=Date.now()+90_000;
const watchdog=setTimeout(()=>{if(!finished){tail=`90-second native execution limit reached during ${phase}`;child.kill();}},90_000);
async function until(check:()=>boolean){while(!check()){if(finished)throw new Error(`Native process exited during ${phase}: `+redact(tail));if(Date.now()>deadline)throw new Error(`Native test timed out during ${phase}; reported model cost $${cost.toFixed(4)}: `+redact(tail));await new Promise(r=>setTimeout(r,100));}}
try {
  await until(()=>initial&&bob.state.bindings().some(b=>b.sourceId===sourceId));
  phase='inbox acknowledgement and reply';console.log('Native test: initial turn complete and hook registered; offering the peer question.');
  const target=bob.state.bindings().find(b=>b.sourceId===sourceId)!;
  assert.ok(target.endpoint && target.inboxToken,'Claude SessionStart did not export a usable local inbox');
  await native.tick();await alice.connector.tick();
  const request=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:target.id,question:'Please answer with the acceptance marker.'}) as {eventId:string};
  await alice.connector.tick();await native.tick();
  await until(()=>bob.state.pending().some(job=>job.action==='events'&&(job.body as any).kind==='reply'&&(job.body as any).replyTo===request.eventId));
  assert.equal(bob.state.delivery(request.eventId,target.id)?.state,'delivered','Source session did not explicitly acknowledge the question');
  await native.tick();await alice.connector.tick();
  const answer=alice.state.events().find(event=>event.replyTo===request.eventId);assert.equal(answer?.text,'RELAY_NATIVE_OK');assert.equal(answer?.sessionId,target.id);
  console.log(`Native Claude acceptance PASS: idle-session inbox → MCP acknowledgement → source-session reply. Reported model cost so far: $${cost.toFixed(4)}; provider budget cap: $0.50.`);
}finally{
  clearTimeout(watchdog);
  child.stdin.end();
  if(!finished){await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,1500))]);}
  if(!finished){child.kill();await new Promise(r=>child.once('exit',r));}
  lines.close();await native.stop();await fixture.cleanup();
}
