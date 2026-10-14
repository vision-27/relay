import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { State, loadConnection } from './state.js';
import { Remote } from './client.js';
import { receiveArtifact, sha } from './artifacts.js';
export async function backupProject(state:State){
  const remote=new Remote(loadConnection(state.dir)),snapshot=await remote.call<any>('snapshot');
  const events:any[]=[];let cursor=0;
  while(true){const page=await remote.events(cursor);events.push(...page.events);if(page.events.length)cursor=page.events.at(-1)!.seq;if(page.events.length<200)break;}
  const artifacts:any[]=[];
  for(const artifact of (await remote.call<any>('artifacts')).artifacts){if(!artifact.sealed)continue;const received=await receiveArtifact(state,artifact.id);artifacts.push({manifest:artifact,payload:readFileSync(received.file,'utf8')});}
  const data=JSON.stringify({version:1,at:new Date().toISOString(),projectId:loadConnection(state.dir).projectId,snapshot,events,artifacts,cursor,coverage:'Point-in-time paginated export; concurrent writes may follow this cursor. No membership tokens or provider credentials.'});
  const dir=join(state.dir,'backups');mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,new Date().toISOString().replace(/[:.]/g,'-')+'.json');writeFileSync(file,data,{mode:0o600});writeFileSync(file+'.sha256',sha(data),{mode:0o600});
  return {file,sha256:sha(data),events:events.length,artifacts:artifacts.length,cursor};
}
export async function pruneArtifacts(state:State,sessionId:string,backupFile:string,days=7){
  if(!Number.isInteger(days)||days<1)throw new Error('Retention must be at least one day');
  const data=readFileSync(backupFile,'utf8');if(!existsSync(backupFile+'.sha256')||sha(data)!==readFileSync(backupFile+'.sha256','utf8'))throw new Error('Backup integrity check failed');
  const saved=JSON.parse(data),config=loadConnection(state.dir);if(saved.projectId!==config.projectId)throw new Error('Backup belongs to another project');
  const remote=new Remote(config);const current=await remote.call<any>('snapshot');
  const referenced=new Set<string>();let cursor=0;while(true){const page=await remote.events(cursor);for(const e of page.events){if(e.artifactId&&e.kind!=='artifact')referenced.add(e.artifactId);}if(page.events.length)cursor=page.events.at(-1)!.seq;if(page.events.length<200)break;}
  if(current.acceptedRevision?.artifactId)referenced.add(current.acceptedRevision.artifactId);
  const removed=[];
  for(const item of saved.artifacts){if(referenced.has(item.manifest.id)||Date.parse(item.manifest.createdAt)>Date.now()-days*86400000)continue;if(sha(item.payload)!==item.manifest.sha256)throw new Error('Archived artifact is corrupt');await remote.call('artifacts',{operation:'delete',sessionId,id:item.manifest.id,archivedHash:item.manifest.sha256});removed.push(item.manifest.id);}
  const archivedTasks=[];for(const task of saved.snapshot.tasks??[]){if(!['complete','released'].includes(task.status)||Date.parse(task.updatedAt)>Date.now()-days*86400000)continue;try{await remote.call('taskarchive',{id:task.id,archivedTask:task});archivedTasks.push(task.id);}catch(error){if((error as any).status!==409)throw error;}}
  return {removed,archivedTasks,preserved:'Referenced artifacts, current accepted integration, and recent artifacts. Event history is retained.'};
}
