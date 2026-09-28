import { connect } from 'node:net';
import type { Binding } from './state.js';
// Optional presentation only. Exact recorded targets; never type input, press keys,
// change focus, expose sockets remotely, or relax a terminal's access policy.
export async function terminalStatus(binding:Binding,status:'online'|'offline'):Promise<boolean>{
  const terminal=binding.terminal;if(!terminal?.socket||!terminal.workspace||!terminal.surface)return false;
  if(!/^[\w:-]+$/.test(terminal.workspace)||!/^[\w:-]+$/.test(terminal.surface))return false;
  if(terminal.kind==='wmux'&&!terminal.token)return false;
  return new Promise(resolve=>{
    const socket=connect(terminal.socket!);let finished=false;
    const finish=(success:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);socket.destroy();resolve(success);};
    const timer=setTimeout(()=>finish(false),500);
    socket.on('connect',()=>{
      const request=terminal.kind==='wmux'
        ?JSON.stringify({id:crypto.randomUUID(),method:'sidebar.set_status',params:{key:'relay_next',value:status,caller:terminal.surface,workspaceId:terminal.workspace},token:terminal.token})
        :`set_status relay_next ${status} --tab=${terminal.workspace}`;
      socket.write(request+'\n');
    });
    socket.on('data',data=>{const text=String(data);finish(!/"ok"\s*:\s*false|"error"|^ERR/i.test(text));});
    socket.on('error',()=>finish(false));socket.on('end',()=>finish(false));
  });
}
