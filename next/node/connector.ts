import { publicSession, type State } from './state.js';
import { Remote, HttpError } from './client.js';
import { message } from './adapters.js';
import type { Deliver } from './adapters.js';
import type { Receipt, Session } from '../core/types.js';
import { terminalStatus } from './terminal.js';
export class Connector {
  private ticking=false;
  private stopped=false;
  private socket?:ReturnType<Remote['subscribe']>;
  private timer?:NodeJS.Timeout;
  private reconnect?:NodeJS.Timeout;
  private failures=0;
  private dirty=true;
  private lastNetwork=0;
  private protocol:number|undefined;
  private retryAfter=0;
  constructor(readonly state:State,readonly remote:Remote,private deliver:Deliver) {}
  async tick(force=true):Promise<void> {
    if(this.ticking||this.stopped||(!force&&Date.now()<this.retryAfter))return;this.ticking=true;
    try {
      const pending=this.state.pending();
      if(this.protocol===undefined){const info=await this.remote.call<any>('snapshot');this.protocol=info.protocol??1;this.state.set('serverProtocol',this.protocol);}
      if(this.protocol!<2&&pending.some(j=>j.action==='events'&&(['artifact','integration'].includes((j.body as any).kind)||(j.body as any).phase)))throw new Error('Update the Relay service to protocol 2 before synchronizing collaboration events; outbox retained');
      const bindings=this.state.bindings();
      const changed=bindings.some(b=>{const previous=this.state.get<{json:string;at:number}>(`registered:${b.id}`);return !previous||(previous.json!==JSON.stringify(publicSession(b))&&Date.now()-previous.at>=10_000);});
      if(!force&&!this.dirty&&!pending.length&&!changed&&Date.now()-this.lastNetwork<300_000)return;
      if(!force&&this.lastNetwork&&Date.now()-this.lastNetwork<1000)return;
      this.dirty=false;this.lastNetwork=Date.now();
      // Register before draining events. Native credentials never leave this machine.
      for(const binding of this.state.bindings()){
        const key=`registered:${binding.id}`, previous=this.state.get<{json:string;at:number}>(key);
        const session=publicSession(binding), json=JSON.stringify(session);
        if(session.state==='closed'&&previous?.json===json)continue;
        if(!previous||(previous.json!==json&&(force||Date.now()-previous.at>=10_000))){
          await this.remote.call('sessions',session);this.state.set(key,{json,at:Date.now()});
        }
      }
      for(const job of this.state.pending()) {
        try { const result=await this.remote.call<any>(job.action,job.body);this.state.remove(job.id);if(job.action==='events'&&result?.kind==='reply'&&result.phase!=='progress')this.state.mark(result.replyTo,result.sessionId,'answered','Reply stored remotely'); }
        catch(error){
          if(error instanceof HttpError && [400,403,404,409,413].includes(error.status)){
            this.state.set(`rejected:${job.id}`,{action:job.action,error:error.message,at:new Date().toISOString()});this.state.remove(job.id);
          } else throw error;
        }
      }
      // Persist pages and cursor in the same transaction. Reconnect resumes from it.
      while(true){const page=await this.remote.events(this.state.get<number>('cursor')??0);this.state.measure('network:events',JSON.stringify(page));this.state.cache(page.events);if(page.events.length<200)break;}
      const snapshot=await this.remote.call<{sessions:Session[];receipts:Receipt[]}>('snapshot');this.state.measure('network:snapshot',JSON.stringify(snapshot));this.state.set('snapshot',snapshot);
      this.state.set('lastSync',new Date().toISOString());this.state.set('syncError',null);this.failures=0;
      await this.updateTerminals('online');
      for(const binding of this.state.bindings())for(const event of this.state.messages(binding.id)){
        const receipt=snapshot.receipts.find(r=>r.eventId===event.id&&r.sessionId===binding.id);
        if(receipt && ['answered','delivered'].includes(receipt.state)){this.state.mark(event.id,binding.id,receipt.state);continue;}
        if(event.phase==='progress'&&!event.urgent){continue;}
        const previous=this.state.delivery(event.id,binding.id);
        if(previous && previous.state!=='held')continue;
        const heldKey=`held-binding:${event.id}:${binding.id}`;
        const readiness=JSON.stringify([binding.state,binding.hookSeenAt,binding.endpoint,Boolean(binding.inboxToken)]);
        if(previous?.state==='held'&&this.state.get<string>(heldKey)===readiness)continue;
        // Persist before the side effect. A process crash here is ambiguous, so no blind replay.
        this.state.measure('native:'+event.kind,message(event));
        this.state.mark(event.id,binding.id,'attempting','Native delivery in progress');
        let result;
        try {result=await this.deliver(binding,event);} catch {result={state:'uncertain' as const,detail:'Native delivery interrupted; use hook delivery or inspect the session'};}
        if(this.state.delivery(event.id,binding.id)?.state!=='delivered'){
          this.state.mark(event.id,binding.id,result.state,result.detail);
          if(result.state==='held')this.state.set(heldKey,readiness);
          if(previous?.state!==result.state||previous?.detail!==result.detail)
            this.state.enqueue('receipts',{eventId:event.id,sessionId:binding.id,...result},`receipt:${event.id}:${binding.id}`);
        }
      }
    } catch(error){this.failures++;this.retryAfter=Date.now()+Math.min(300_000,1000*2**Math.min(this.failures,9));this.state.set('syncError',{message:(error as Error).message,at:new Date().toISOString()});await this.updateTerminals('offline');}
    finally{this.ticking=false;}
  }
  private async updateTerminals(status:'online'|'offline'){
    for(const binding of this.state.bindings()){
      if(!binding.terminal)continue;
      const key=`terminal:${binding.id}`,last=this.state.get<{status:string;at:number;ok:boolean}>(key);
      if(last?.status===status&&(last.ok||Date.now()-last.at<30_000))continue;
      const ok=await terminalStatus(binding,status);this.state.set(key,{status,at:Date.now(),ok});
    }
  }
  start() {
    for(const event of this.state.events())if(event.targetSessionId && this.state.delivery(event.id,event.targetSessionId)?.state==='attempting'){
      this.state.mark(event.id,event.targetSessionId,'uncertain','Connector restarted during native delivery; no automatic replay');
      this.state.enqueue('receipts',{eventId:event.id,sessionId:event.targetSessionId,state:'uncertain',detail:'Connector restarted during native delivery'},`receipt:${event.id}:${event.targetSessionId}`);
    }
    let reconnectFailures=0;
    const reconnect=()=>{if(!this.stopped)this.reconnect=setTimeout(connect,Math.min(300_000,1000*2**Math.min(++reconnectFailures,9)));};
    const connect=()=>{if(this.stopped)return;
      try {this.socket=this.remote.subscribe(()=>{reconnectFailures=0;this.dirty=true;void this.tick(false);},reconnect);}
      catch(error){this.state.set('syncError',{message:(error as Error).message,at:new Date().toISOString()});reconnect();}
    };connect();
    const loop=async()=>{await this.tick(false);if(!this.stopped)this.timer=setTimeout(loop,this.failures?Math.min(30_000,1000*2**Math.min(this.failures,5)):1000);};void loop();
  }
  async stop(){this.stopped=true;clearTimeout(this.timer);clearTimeout(this.reconnect);this.socket?.terminate();while(this.ticking)await new Promise(r=>setTimeout(r,10));}
}
