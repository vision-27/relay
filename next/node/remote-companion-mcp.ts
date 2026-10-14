import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startCompanion, type CompanionConnection } from './remote-companion.js';

/** Start the delivery listener with the MCP connection, without an OS service. */
export async function runCompanionMcp(connection:CompanionConnection){
  const companion=await startCompanion(connection),lines=createInterface({input:process.stdin});
  const endpoint=`${new URL(connection.server).origin}/projects/${connection.projectId}/mcp`;
  lines.on('line',async line=>{
    let input:any;
    try{
      if(Buffer.byteLength(line)>40000)throw Error('MCP request too large');input=JSON.parse(line);
      const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:line,signal:AbortSignal.timeout(15000)});
      if(response.status===204||response.status===202)return;
      const result=await response.json() as any;
      if(!response.ok&&!result.jsonrpc)throw Error('Relay MCP request failed ('+response.status+')');
      process.stdout.write(JSON.stringify(result)+'\n');
    }catch(error){if(input?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,error:{code:-32603,message:(error as Error).message}})+'\n');}
  });
  lines.on('close',()=>companion.stop());
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{companion.stop();lines.close();});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const config=process.argv[2];if(!config)throw Error('A private Relay connection file is required');
  runCompanionMcp(JSON.parse(readFileSync(config,'utf8'))).then(()=>writeFileSync(config+'.mcp-active',String(Date.now()),{mode:0o600})).catch(error=>{console.error((error as Error).message);process.exitCode=1;});
}
