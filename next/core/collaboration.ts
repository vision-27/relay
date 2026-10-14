import { assert, bounded, hash, id, overlap, paths, stable, redact, type Member, type Session, type Sql } from './types.js';
export interface Task {id:string;sessionId:string;title:string;paths:string[];dependencies:string[];baseHead:string|null;status:'active'|'blocked'|'complete'|'released';version:number;expiresAt:number;updatedAt:string}
export interface Artifact {id:string;sessionId:string;sha256:string;size:number;chunks:number;paths:string[];source:Session['git'];createdAt:string;expiresAt:number;sealed:boolean;summary:string}
interface Project {own(member:Member,sessionId:string):Session;session(sessionId:string):Session;project():{repository:string}}
export class Collaboration {
  constructor(private sql:Sql,private project:Project){
    sql.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS artifact_chunks(artifact_id TEXT NOT NULL,part INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(artifact_id,part))');
  }
  accepted(){const row=this.sql.all<{value:string}>("SELECT value FROM meta WHERE key='acceptedRevision'")[0];return row?JSON.parse(row.value):null;}
  integrate(member:Member,input:any){
    const session=this.project.own(member,id(input.sessionId));assert(session.state!=='closed',409,'Resume this session before changing collaboration state');const artifact=this.artifact(input.artifactId);assert(artifact.sealed,409,'Artifact is not ready');
    if(input.operation==='reserve'){
      assert(/^[a-f0-9]{40,64}$/.test(input.baseHead),400,'Invalid base revision');
      const accepted=this.accepted();if(accepted?.id===input.id){assert(accepted.sessionId===session.id&&accepted.artifactId===artifact.id,409,'Integration identifier reused');return accepted;}
      assert(!accepted||accepted.head===input.baseHead,409,'Accepted revision changed; refresh before integrating');this.checkScopes(session.id,artifact.paths,input.baseHead);
      const row=this.sql.all<{value:string}>("SELECT value FROM meta WHERE key='integrationLease'")[0];const current=row?JSON.parse(row.value):null;
      assert(!current||current.expiresAt<=Date.now()||(current.id===input.id&&current.sessionId===session.id),409,'Another integration is being accepted; retry after its reservation expires');
      const lease={id:id(input.id),sessionId:session.id,artifactId:artifact.id,baseHead:input.baseHead,expiresAt:Date.now()+120000};
      this.sql.exec("INSERT INTO meta VALUES ('integrationLease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(lease));return lease;
    }
    assert(/^[a-f0-9]{40,64}$/.test(input.head)&&/^[a-f0-9]{40,64}$/.test(input.baseHead),400,'Invalid revision');
    assert(session.git.head===input.head&&!session.git.dirty,409,'Register the accepted clean revision first');
    assert(input.validation?.exitCode===0&&Array.isArray(input.validation.command)&&input.validation.command.length>0&&/^[a-f0-9]{64}$/.test(input.validation.outputHash),400,'Successful local validation evidence required');
    const previous=this.accepted();if(previous?.id===input.id){assert(previous.head===input.head&&previous.artifactId===input.artifactId,409,'Integration identifier reused');return previous;}
    const leaseRow=this.sql.all<{value:string}>("SELECT value FROM meta WHERE key='integrationLease'")[0],lease=leaseRow?JSON.parse(leaseRow.value):null;assert(lease&&lease.id===input.id&&lease.sessionId===session.id&&lease.artifactId===artifact.id&&lease.baseHead===input.baseHead&&lease.expiresAt>Date.now(),409,'Acquire an integration reservation before publishing acceptance');
    assert(!previous||previous.head===input.baseHead,409,'Accepted revision changed; refresh before integrating');
    const record={id:id(input.id),head:input.head,baseHead:input.baseHead,artifactId:artifact.id,sessionId:session.id,at:new Date().toISOString(),verification:'Reported by integrating member; server did not execute tests',validation:input.validation};
    assert(JSON.stringify(record).length<8000,413,'Validation evidence too large');this.sql.exec("INSERT INTO meta VALUES ('acceptedRevision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(record));this.sql.exec("DELETE FROM meta WHERE key='integrationLease'");return record;
  }
  archiveTask(member:Member,input:any){
    const task=this.task(input.id);assert(member.role==='owner'||this.project.own(member,task.sessionId),403,'Only the owner can archive this task');
    assert(['complete','released'].includes(task.status)&&stable(task)===stable(input.archivedTask),409,'Archive the exact completed task version first');
    assert(!this.tasks().some(t=>t.id!==task.id&&t.dependencies.includes(task.id)),409,'Another task references this dependency');
    this.sql.exec('DELETE FROM tasks WHERE id=?',task.id);return {archived:true};
  }
  tasks():Task[]{return this.sql.all<{data:string}>('SELECT data FROM tasks ORDER BY rowid DESC LIMIT 500').map(r=>JSON.parse(r.data));}
  task(taskId:string):Task {const row=this.sql.all<{data:string}>('SELECT data FROM tasks WHERE id=?',id(taskId))[0];assert(row,404,'Task not found');return JSON.parse(row.data);}
  checkScopes(sessionId:string,scope:string[],baseHead:string|null){
    const accepted=this.accepted();assert(!accepted||accepted.head===baseHead,409,'Starting revision is stale; integrate the accepted revision before reserving or exporting changes');
    const collision=this.tasks().find(t=>t.sessionId!==sessionId&&['active','blocked'].includes(t.status)&&t.expiresAt>Date.now()&&scope.some(p=>t.paths.some(q=>overlap(p,q))));
    assert(!collision,409,`Scope reserved by task ${collision?.id}; request a handoff or choose other files`);
  }
  mutateTask(member:Member,input:any):Task {
    const session=this.project.own(member,id(input.sessionId));assert(session.state!=='closed',409,'Resume this session before changing collaboration state');
    return this.sql.transaction(()=>{
      const now=Date.now(),existing=input.id?this.task(input.id):undefined;
      if(existing){assert(input.version===existing.version,409,'Task changed; refresh its version');assert(existing.sessionId===session.id||(existing.expiresAt<=now&&(input.operation??'claim')==='claim'),403,'Task belongs to another session; ask for a handoff');}
      const operation=input.operation??'claim';assert(['claim','renew','handoff','complete','release','block'].includes(operation),400,'Invalid task operation');
      assert(existing||operation==='claim',400,'Create a task before updating it');
      const scope=input.paths===undefined?existing?.paths??[]:paths(input.paths);assert(scope.length>0,400,'Reserve explicit paths');
      const dependencies=input.dependencies??existing?.dependencies??[];assert(Array.isArray(dependencies)&&dependencies.length<=20,400,'At most 20 dependencies');
      for(const dependency of dependencies){assert(dependency!==existing?.id,400,'A task cannot depend on itself');assert(this.task(id(dependency)).status==='complete',409,'Dependency is not complete');}
      let owner=session.id;
      if(operation==='handoff'){assert(existing?.sessionId===session.id,403,'Only the current owner can hand off');owner=this.project.session(id(input.targetSessionId)).id;assert(this.project.session(owner).state!=='closed',409,'Target session is closed');}
      const baseHead=input.baseHead??existing?.baseHead??session.git.head;assert(baseHead===null||/^[a-f0-9]{40,64}$/.test(baseHead),400,'Invalid base revision');
      if(['claim','renew','handoff'].includes(operation))this.checkScopes(session.id,scope,baseHead);
      const ttl=input.ttlSeconds??900;assert(Number.isInteger(ttl)&&ttl>=60&&ttl<=3600,400,'Lease must be 60..3600 seconds');
      if(!existing)assert(this.sql.all<{n:number}>('SELECT count(*) n FROM tasks')[0]!.n<500,429,'Task history limit reached; archive completed tasks');
      const task:Task={id:existing?.id??crypto.randomUUID(),sessionId:owner,title:redact(bounded(input.title??existing?.title,300)),paths:scope,dependencies,baseHead,status:operation==='complete'?'complete':operation==='release'?'released':operation==='block'?'blocked':'active',version:(existing?.version??0)+1,expiresAt:now+ttl*1000,updatedAt:new Date(now).toISOString()};
      this.sql.exec('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',task.id,JSON.stringify(task));return task;
    });
  }
  artifact(artifactId:string):Artifact {const row=this.sql.all<{data:string}>('SELECT data FROM artifacts WHERE id=?',id(artifactId))[0];assert(row,404,'Artifact not found');return JSON.parse(row.data);}
  artifacts(){return this.sql.all<{data:string}>('SELECT data FROM artifacts ORDER BY rowid DESC LIMIT 100').map(r=>JSON.parse(r.data) as Artifact);}
  chunk(artifactId:string,part:number){const artifact=this.artifact(artifactId);assert(artifact.sealed,409,'Artifact upload is incomplete');assert(Number.isInteger(part)&&part>=0&&part<artifact.chunks,400,'Invalid chunk');return this.sql.all<{data:string}>('SELECT data FROM artifact_chunks WHERE artifact_id=? AND part=?',artifactId,part)[0]!;}
  async mutateArtifact(member:Member,input:any){
    const session=this.project.own(member,id(input.sessionId));assert(session.state!=='closed',409,'Resume this session before changing collaboration state');
    if(input.operation==='begin'){
      const artifactId=id(input.id),source=input.source;assert(source?.repository===this.project.project().repository,409,'Artifact belongs to a different repository');
      assert(JSON.stringify(source).length<20000,413,'Source metadata too large');
      const scope=paths(input.paths);assert(scope.length>0,400,'Select files to export');this.checkScopes(session.id,scope,source.head);
      assert(/^[a-f0-9]{64}$/.test(input.sha256),400,'Invalid artifact hash');assert(Number.isInteger(input.size)&&input.size>0&&input.size<=2_000_000,413,'Artifact limit is 2 MB encoded');
      assert(input.chunks===Math.ceil(input.size/24000),400,'Invalid chunk count');
      const found=this.sql.all<{data:string}>('SELECT data FROM artifacts WHERE id=?',artifactId)[0];
      if(found){const previous:Artifact=JSON.parse(found.data);assert(previous.sessionId===session.id&&previous.sha256===input.sha256&&previous.size===input.size,409,'Artifact ID reused');return previous;}
      const entries=this.artifacts();assert(entries.length<100&&entries.reduce((n,a)=>n+a.size,0)+input.size<=20_000_000,429,'Artifact quota reached; archive and prune old artifacts');
      const artifact:Artifact={id:artifactId,sessionId:session.id,sha256:input.sha256,size:input.size,chunks:input.chunks,paths:scope,source,summary:redact(bounded(input.summary??'Selected source files',500)),createdAt:new Date().toISOString(),expiresAt:Date.now()+7*86400000,sealed:false};
      this.sql.exec('INSERT INTO artifacts VALUES (?,?)',artifact.id,JSON.stringify(artifact));return artifact;
    }
    const artifact=this.artifact(input.id);assert(artifact.sessionId===session.id||member.role==='owner',403,'Artifact belongs to another session');
    if(input.operation==='abort'){assert(!artifact.sealed,409,'Sealed artifacts require verified archival before deletion');this.sql.transaction(()=>{this.sql.exec('DELETE FROM artifact_chunks WHERE artifact_id=?',artifact.id);this.sql.exec('DELETE FROM artifacts WHERE id=?',artifact.id);});return {aborted:true};}
    if(input.operation==='delete'){
      const referenced=this.sql.all("SELECT id FROM events WHERE json_extract(data,'$.artifactId')=? AND (json_extract(data,'$.kind')!='artifact' OR (json_extract(data,'$.targetSessionId') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM receipts WHERE event_id=events.id AND json_extract(receipts.data,'$.state') IN ('delivered','answered')))) LIMIT 1",artifact.id);assert(!referenced.length&&this.accepted()?.artifactId!==artifact.id,409,'Artifact is still referenced by evidence or unresolved delivery');
      assert(input.archivedHash===artifact.sha256,409,'Verify an archived copy before pruning');
      this.sql.transaction(()=>{this.sql.exec('DELETE FROM artifact_chunks WHERE artifact_id=?',artifact.id);this.sql.exec('DELETE FROM artifacts WHERE id=?',artifact.id);});return {deleted:true};
    }
    assert(artifact.sessionId===session.id,403,'Only the exporting session can upload');
    if(input.operation==='chunk'){
      const part=input.part;assert(Number.isInteger(part)&&part>=0&&part<artifact.chunks,400,'Invalid chunk');const data=bounded(input.data,24000);
      const prior=this.sql.all<{data:string}>('SELECT data FROM artifact_chunks WHERE artifact_id=? AND part=?',artifact.id,part)[0];
      if(prior){assert(prior.data===data,409,'Chunk differs from prior upload');return {stored:true};}
      assert(!artifact.sealed,409,'Sealed artifacts are immutable');this.sql.exec('INSERT INTO artifact_chunks VALUES (?,?,?)',artifact.id,part,data);return {stored:true};
    }
    assert(input.operation==='seal',400,'Invalid artifact operation');
    const chunks=this.sql.all<{data:string}>('SELECT data FROM artifact_chunks WHERE artifact_id=? ORDER BY part',artifact.id);const payload=chunks.map(c=>c.data).join('');
    assert(chunks.length===artifact.chunks&&payload.length===artifact.size&&await hash(payload)===artifact.sha256,409,'Incomplete or corrupt artifact');
    artifact.sealed=true;this.sql.exec('UPDATE artifacts SET data=? WHERE id=?',JSON.stringify(artifact),artifact.id);return artifact;
  }
}
