import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, relative, join, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths, redact } from '../core/types.js';
import type { Artifact } from '../core/collaboration.js';
import { snapshot } from './git.js';
import { Remote } from './client.js';
import { State, loadConnection } from './state.js';
export interface ArtifactFile {path:string;before:string|null;after:string|null;data:string|null;mode:'100644'|'100755'}
export interface Bundle {version:1;repository:string;baseHead:string;files:ArtifactFile[]}
export const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export function gitBytes(repo:string,args:string[]):Buffer{return execFileSync('git',['-C',repo,...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:4_000_000,timeout:15000});}
export function gitText(repo:string,args:string[]){return gitBytes(repo,args).toString('utf8').trim();}
export function safePath(repo:string,file:string){
  paths([file]);if(!file||file.includes('\\')||file.includes(':')||file.includes('\0')||file.startsWith('-')||file.split('/').some(p=>!p||p==='.'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p)))throw new Error('Unsafe artifact path');
  if(file.split('/').some(p=>['.git','.relay','.codex','.claude','node_modules'].includes(p.toLowerCase())||/^\.env(?:\.|$)/i.test(p)||/\.(pem|key|p12|pfx|sqlite3?)(?:-|$)/i.test(p)||/^(credentials|secrets?)(\.|$)/i.test(p))||file==='.mcp.json')throw new Error('Private or operational file cannot be exported');
  const base=realpathSync(repo),target=resolve(base,file);const rel=relative(base,target);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Path outside repository');
  let current=base;for(const part of file.split('/')){current=join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('Symlinks cannot be transferred or traversed');}
  return target;
}
function baseline(repo:string,head:string,file:string){
  const entry=gitText(repo,['ls-tree',head,'--',file]);if(!entry)return {bytes:null,mode:'100644' as const};
  const match=entry.match(/^(100644|100755) blob ([a-f0-9]+)\t/);if(!match)throw new Error('Only regular source files can be transferred');
  return {bytes:gitBytes(repo,['cat-file','blob',match[2]!]),mode:match[1] as '100644'|'100755'};
}
export function buildBundle(repo:string,selected:string[],repository:string,allowUntracked=false,baseRef?:string):{bundle:Bundle;payload:string;source:ReturnType<typeof snapshot>}{
  const source=snapshot(repo,repository);if(!source.head)throw new Error('Commit a baseline before exporting changes');
  const baseHead=baseRef??source.head;if(!/^[a-f0-9]{40,64}$/.test(baseHead))throw new Error('base_ref must be a full commit hash');gitText(repo,['cat-file','-e',baseHead+'^{commit}']);
  const names=paths(selected);if(!names.length||new Set(names.map(p=>p.toLowerCase())).size!==names.length)throw new Error('Select unique file paths');
  let total=0;const files=names.map(file=>{
    const target=safePath(repo,file),before=baseline(repo,baseHead,file);if(!gitText(repo,['ls-files','--',file])&&!allowUntracked)throw new Error('Untracked files require explicit allow_untracked');
    if(!before.bytes&&!existsSync(target))throw new Error('Selected file does not exist');
    let bytes:Buffer|null=null,mode=before.mode;
    if(existsSync(target)){const stat=lstatSync(target);if(!stat.isFile()||stat.size>1_000_000)throw new Error('Select regular files up to 1 MB');bytes=readFileSync(target);total+=bytes.length;
      if(process.platform!=='win32')mode=stat.mode&0o111?'100755':'100644';
      const text=bytes.toString('utf8');if(redact(text)!==text||/-----BEGIN [^-]*PRIVATE KEY-----/.test(text))throw new Error('Possible credential found; remove it before export');
    }
    return {path:file,before:before.bytes?sha(before.bytes):null,after:bytes?sha(bytes):null,data:bytes?bytes.toString('base64'):null,mode};
  });
  if(total>1_000_000)throw new Error('Selected artifact exceeds 1 MB; select a smaller set of files');
  const after=snapshot(repo,repository);if(after.head!==source.head||after.fingerprint!==source.fingerprint)throw new Error('Checkout changed during capture; retry');
  const bundle:Bundle={version:1,repository,baseHead,files};const payload=JSON.stringify(bundle);if(payload.length>2_000_000)throw new Error('Encoded artifact is too large');return {bundle,payload,source};
}
export function verifyBundle(payload:string,artifact:Artifact,repo:string):Bundle {
  if(payload.length!==artifact.size||sha(payload)!==artifact.sha256)throw new Error('Artifact hash mismatch');
  const bundle:Bundle=JSON.parse(payload);if(bundle.version!==1||bundle.repository!==artifact.source.repository||!Array.isArray(bundle.files)||!bundle.files.length||bundle.files.length>50||!/^[a-f0-9]{40,64}$/.test(bundle.baseHead))throw new Error('Invalid artifact manifest');
  if(JSON.stringify(bundle.files.map(f=>f.path))!==JSON.stringify(artifact.paths)||new Set(bundle.files.map(f=>f.path.toLowerCase())).size!==bundle.files.length)throw new Error('Artifact paths do not match manifest');
  for(const file of bundle.files){safePath(repo,file.path);if(!['100644','100755'].includes(file.mode)||!(file.before===null||/^[a-f0-9]{64}$/.test(file.before)))throw new Error('Invalid file metadata');
    if(file.data===null){if(file.after!==null||file.before===null)throw new Error('Invalid deletion');}
    else {if(typeof file.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)||sha(Buffer.from(file.data,'base64'))!==file.after)throw new Error('File hash mismatch');}
  }return bundle;
}
export async function exportArtifact(state:State,args:Record<string,any>){
  if(args.share!==true)throw new Error('Set share=true only for files the local user has authorized sharing');
  const session=state.binding(args.session_id),repo=state.get<string>('repo')!,remote=new Remote(loadConnection(state.dir));
  const {payload,source}=buildBundle(repo,args.paths,session.git.repository,args.allow_untracked===true,args.base_ref);
  session.git=source;state.bind(session);await remote.call('sessions',sessionPublic(session));
  const artifactId=sha(session.id+payload),parts=Math.ceil(payload.length/24000);
  const manifest={operation:'begin',id:artifactId,sessionId:session.id,sha256:sha(payload),size:payload.length,chunks:parts,paths:args.paths,source,summary:args.summary??'Selected source changes'};
  await remote.call('artifacts',manifest);
  for(let part=0;part<parts;part++)await remote.call('artifacts',{operation:'chunk',id:artifactId,sessionId:session.id,part,data:payload.slice(part*24000,(part+1)*24000)});
  const artifact=await remote.call<Artifact>('artifacts',{operation:'seal',id:artifactId,sessionId:session.id});
  if(!state.get('artifact_notice:'+artifactId))state.sql.transaction(()=>{state.publish({id:'artifact_'+artifactId,sessionId:session.id,kind:'artifact',artifactId,text:artifact.summary,paths:artifact.paths,git:artifact.source,occurredAt:artifact.createdAt,...(args.target_session_id?{targetSessionId:args.target_session_id}:{})});state.set('artifact_notice:'+artifactId,true);});
  state.measure('artifact:export',payload);return {artifact,transferredChars:payload.length,note:'Exact file bytes transferred; source was not generated as a model response. Receiving does not apply changes.'};
}
function sessionPublic(session:any){const {endpoint,inboxToken,transcriptPath,hookSeenAt,terminal,...rest}=session;return rest;}
export async function receiveArtifact(state:State,artifactId:string){
  const remote=new Remote(loadConnection(state.dir)),repo=state.get<string>('repo')!;
  const artifact=await remote.call<Artifact>('artifacts?id='+encodeURIComponent(artifactId));if(!artifact.sealed)throw new Error('Artifact is not sealed');if(artifact.size>2_000_000||artifact.chunks!==Math.ceil(artifact.size/24000)||artifact.chunks<1)throw new Error('Invalid artifact size');
  const file=join(state.dir,'artifacts',artifactId+'.json');let payload='';
  if(existsSync(file))payload=readFileSync(file,'utf8');else{for(let part=0;part<artifact.chunks;part++)payload+=(await remote.call<{data:string}>(`artifacts?id=${encodeURIComponent(artifactId)}&part=${part}`)).data;}
  const bundle=verifyBundle(payload,artifact,repo);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,payload,{mode:0o600});
  writeFileSync(file+'.manifest',JSON.stringify(artifact),{mode:0o600});state.measure('artifact:receive',payload);return {artifact,bundle,file};
}
export function readArtifact(bundle:Bundle,file:string,offset=0,limit=2000){const entry=bundle.files.find(f=>f.path===file);if(!entry)throw new Error('File is not in artifact');if(entry.data===null)return {path:file,deleted:true};const bytes=Buffer.from(entry.data,'base64'),body=bytes.toString('utf8');if(body.includes('\0')||!Buffer.from(body).equals(bytes))return {path:file,binary:true,bytes:bytes.length,sha256:entry.after};return {path:file,text:body.slice(offset,offset+limit),offset,nextOffset:offset+limit<body.length?offset+limit:null,totalChars:body.length,sha256:entry.after};}
