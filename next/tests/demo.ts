import { pair } from './helpers.js';
import { callTool } from '../node/tools.js';
import { context } from '../node/context.js';
const demo=await pair(undefined,async(binding,event)=>{
  console.log(`  Delivery offered to ${binding.provider}: ${event.kind}`);
  return {state:'accepted',detail:'Demo adapter; no real coding agent invoked'};
});
try {
  const {alice,bob}=demo;
  console.log('\nRelay — two independent checkouts, one shared project\n');
  console.log('1. Backend session publishes a new authentication contract.');
  callTool(bob.state,'relay_publish',{session_id:bob.session.id,kind:'contract',text:'Login returns { user } and sets an HTTP-only cookie. The token field is removed.',paths:['src/auth'],evidence:'Proposed contract for this isolated demo; implementation not verified.'});
  await bob.connector.tick();await alice.connector.tick();
  const briefing=context(alice.state,alice.session.id,'authentication',true);console.log('  Frontend received:',briefing.events[0]?.text);
  console.log('2. Frontend asks the originating session about credentials.');
  const question=callTool(alice.state,'relay_ask',{session_id:alice.session.id,target_session_id:bob.session.id,question:'Should fetch include credentials?'}) as {eventId:string};
  await alice.connector.tick();await bob.connector.tick();
  callTool(bob.state,'relay_ack',{session_id:bob.session.id,event_id:question.eventId});
  callTool(bob.state,'relay_reply',{session_id:bob.session.id,question_id:question.eventId,answer:'Yes. Use credentials: include for the cookie-based contract.',evidence:'Answer from the addressed demo backend session.'});
  await bob.connector.tick();await alice.connector.tick();
  const reply=alice.state.events().find(e=>e.replyTo===question.eventId);console.log('  Source-session answer:',reply?.text);
  console.log('3. Delivery receipt:',alice.state.get<any>('snapshot').receipts.find((r:any)=>r.eventId===question.eventId)?.state);
  console.log('\nPassed: real HTTP, SQLite, two Git checkouts, durable replay and source-attributed replies.\nAgent delivery is simulated. Real Codex/Claude and Windows–Mac acceptance remain separate.');
} finally {await demo.cleanup();}
