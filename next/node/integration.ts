import { createHash } from 'node:crypto';
import { redact } from '../core/types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { sha, safePath, gitText, receiveArtifact, type Bundle } from './artifacts.js';
import { snapshot } from './git.js';
import { State, loadConnection, publicSession } from './state.js';
import { Remote } from './client.js';
interface Plan {id:string;artifactId:string;artifactHash:string;baseHead:string;worktree:string;files:string[];status:'prepared'|'validated'|'accepted';tree?:string;commit?:string;validation?:{command:string[];exitCode:number;outputHash:string;at:string};acceptedHead?:string}
const planFile=(state:State,id:string)=>{if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid integration ID');return join(state.dir,'integrations',id+'.json');};
function save(state:State,plan:Plan){writeFileSync(planFile(state,plan.id),JSON.stringify(plan,null,2),{mode:0o600});return plan;}
export function loadPlan(state:State,id:string):Plan{return JSON.parse(readFileSync(planFile(state,id),'utf8'));}
function stageTree(plan:Plan){gitText(plan.worktree,['add','--',...plan.files]);return gitText(plan.worktree,['write-tree']);}
function clean(repo:string){if(gitText(repo,['status','--porcelain','--untracked-files=all']))throw new Error('Integration requires a clean checkout; preserve or commit local work first');}
export async function prepare(state:State,artifactId:string){
  const repo=state.get<string>('repo')!;clean(repo);
  const {artifact,bundle}=await receiveArtifact(state,artifactId),baseHead=gitText(repo,['rev-parse','HEAD']);
  for(const file of bundle.files){const target=safePath(repo,file.path);const actual=existsSync(target)?sha(readFileSync(target)):null;if(actual!==file.before)throw new Error(`Conflict in ${file.path}: local bytes differ from the artifact baseline`);}
  const id=crypto.randomUUID(),worktree=join(state.dir,'integrations',id);mkdirSync(dirname(worktree),{recursive:true});
  gitText(repo,['worktree','add','--detach',worktree,baseHead]);
  for(const file of bundle.files){const target=safePath(worktree,file.path);if(file.data===null){if(existsSync(target))unlinkSync(target);}else{mkdirSync(dirname(target),{recursive:true});writeFileSync(target,Buffer.from(file.data,'base64'));chmodSync(target,file.mode==='100755'?0o755:0o644);}}
  const plan:Plan={id,artifactId,artifactHash:artifact.sha256,baseHead,worktree,files:bundle.files.map(f=>f.path),status:'prepared'};
  plan.tree=stageTree(plan);save(state,plan);
  return {...plan,diffStat:gitText(worktree,['diff','--cached','--stat']),next:'Review the worktree, then validate with an explicit local command. Original checkout is untouched.'};
}
async function execute(command:string[],cwd:string,timeout:number){
  if(!Array.isArray(command)||!command.length||command.length>100||command.some(a=>typeof a!=='string'||a.includes('\0')))throw new Error('Validation requires an executable and argument array');
  return new Promise<{code:number;output:string;outputHash:string}>((resolve,reject)=>{
    let output='',timedOut=false;const digest=createHash('sha256');const child=spawn(command[0]!,command.slice(1),{cwd,windowsHide:true,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32'){spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());}else try{process.kill(-child.pid!,'SIGKILL');}catch{child.kill();}},timeout);
    child.stdout.on('data',data=>{digest.update(data);output=(output+data).slice(-16000);});child.stderr.on('data',data=>{digest.update(data);output=(output+data).slice(-16000);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);resolve({code:timedOut?124:code??1,output,outputHash:digest.digest('hex')});});
  });
}
export async function validate(state:State,id:string,command:string[],timeout=60000){
  if(!Number.isInteger(timeout)||timeout<1000||timeout>120000)throw new Error('Validation timeout must be 1..120 seconds');
  const plan=loadPlan(state,id);if(plan.status==='accepted')throw new Error('Integration is already accepted');
  const expected=plan.tree;plan.status='prepared';delete plan.validation;save(state,plan);
  const result=await execute(command,plan.worktree,timeout);
  const current=stageTree(plan);if(result.code!==0||current!==expected||gitText(plan.worktree,['diff','--name-only'])||gitText(plan.worktree,['ls-files','--others','--exclude-standard']))throw new Error(`Validation failed or changed files (exit ${result.code}). Review worktree before retrying.`);
  plan.validation={command,exitCode:0,outputHash:result.outputHash,at:new Date().toISOString()};plan.status='validated';save(state,plan);
  return {id,status:plan.status,validation:plan.validation,outputTail:redact(result.output.slice(-2000)),next:'Developer-authorized accept is a separate CLI operation.'};
}
export async function accept(state:State,id:string,sessionId:string,approve:boolean){
  if(!approve)throw new Error('Acceptance requires explicit developer authorization and --approve');
  const plan=loadPlan(state,id),repo=state.get<string>('repo')!,session=state.binding(sessionId),remote=new Remote(loadConnection(state.dir));
  if(plan.status!=='accepted'){
    if(plan.status!=='validated'||!plan.validation||plan.validation.exitCode!==0)throw new Error('Run validation successfully before acceptance');
    clean(repo);if(gitText(repo,['rev-parse','HEAD'])!==plan.baseHead)throw new Error('Checkout revision changed; prepare and validate again');
    if(stageTree(plan)!==plan.tree||gitText(plan.worktree,['diff','--name-only'])||gitText(plan.worktree,['ls-files','--others','--exclude-standard']))throw new Error('Prepared files changed after validation');
    const shared=await remote.call<any>('tasks');if(shared.acceptedRevision&&shared.acceptedRevision.head!==plan.baseHead)throw new Error('Shared accepted revision changed; integrate it first');
    const blockers=(shared.tasks??[]).filter((t:any)=>t.sessionId!==sessionId&&['active','blocked'].includes(t.status)&&t.expiresAt>Date.now()&&plan.files.some(p=>t.paths.some((q:string)=>p===q||p.startsWith(q+'/')||q.startsWith(p+'/'))));
    if(blockers.length)throw new Error('Another session reserves these files; arrange a handoff or release before acceptance');
    await remote.call('integrations',{operation:'reserve',sessionId,id:plan.id,artifactId:plan.artifactId,baseHead:plan.baseHead});
    const hooks=join(state.dir,'empty-git-hooks');mkdirSync(hooks,{recursive:true});
    if(!plan.commit){gitText(plan.worktree,['-c',`core.hooksPath=${hooks}`,'-c','commit.gpgsign=false','-c','user.name=Relay Integration','-c','user.email=relay@localhost','commit','-m',`Integrate Relay artifact ${plan.artifactId.slice(0,12)}`]);plan.commit=gitText(plan.worktree,['rev-parse','HEAD']);save(state,plan);}
    // Fast-forward only; Git refuses overlapping work and divergent history.
    gitText(repo,['-c',`core.hooksPath=${hooks}`,'merge','--ff-only',plan.commit]);
    plan.status='accepted';plan.acceptedHead=plan.commit;save(state,plan);
  }
  await remote.call('integrations',{operation:'reserve',sessionId,id:plan.id,artifactId:plan.artifactId,baseHead:plan.baseHead});
  session.git=snapshot(repo,session.git.repository);state.bind(session);await remote.call('sessions',publicSession(session));
  const publication=await remote.call('integrations',{sessionId,id:plan.id,artifactId:plan.artifactId,head:plan.acceptedHead,baseHead:plan.baseHead,validation:plan.validation});
  state.publish({id:'integration_'+plan.id,sessionId,kind:'integration',artifactId:plan.artifactId,text:`Accepted revision ${plan.acceptedHead}; local validation passed. Other checkouts must obtain this commit before claiming alignment.`,paths:plan.files,evidence:JSON.stringify(plan.validation)});
  return {id:plan.id,status:plan.status,head:plan.acceptedHead,publication,pushed:false};
}
