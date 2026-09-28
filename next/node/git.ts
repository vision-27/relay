import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { GitState } from '../core/types.js';
function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C',repo,...args], {encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:10_000,maxBuffer:2_000_000}).trim();
}
export function root(repo: string) { return realpathSync(git(resolve(repo),['rev-parse','--show-toplevel'])); }
export function repositoryIdentity(remote: string): string {
  const value=remote.trim().replace(/\.git$/, '').replace(/\/$/,'');
  const ssh=value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (ssh && !value.includes('://') && !/^[A-Za-z]:/.test(value)) return `${ssh[1]!.toLowerCase()}/${ssh[2]}`;
  try { const url=new URL(value); return `${url.hostname.toLowerCase()}${url.pathname}`.replace(/\/$/,''); } catch { return value.replaceAll('\\','/'); }
}
export function snapshot(repo: string, identity?: string): GitState {
  const base=root(repo);
  let head:string|null=null, branch:string|null=null, remote='';
  try { head=git(base,['rev-parse','HEAD']); } catch { /* unborn repo */ }
  try { branch=git(base,['symbolic-ref','--short','HEAD']); } catch { /* detached */ }
  try { remote=git(base,['remote','get-url','origin']); } catch { /* local demo can supply identity */ }
  if (!remote && !identity) throw new Error('Add this project’s Git remote before connecting, or use --repository with an explicit shared identity.');
  const tracked=git(base,head?['diff','--name-only','HEAD']:['diff','--cached','--name-only']).split(/\r?\n/).filter(Boolean);
  const untracked=git(base,['ls-files','--others','--exclude-standard']).split(/\r?\n/).filter(Boolean);
  const files=[...new Set([...tracked,...untracked])].filter(p=>!p.startsWith('.relay/') && !p.startsWith('node_modules/')).sort();
  const digest=createHash('sha256').update(head??'unborn');
  for (const p of files) {
    digest.update(p); const path=resolve(base,p);
    if (relative(base,path).startsWith('..')) continue;
    if (!existsSync(path)) { digest.update('deleted'); continue; }
    const stat=lstatSync(path);
    if (stat.isFile() && stat.size < 2_000_000) digest.update(readFileSync(path));
    else digest.update(`${stat.size}:${stat.mtimeMs}`);
  }
  return {head,branch,dirty:files.length>0,files:files.slice(0,50),fingerprint:digest.digest('hex'),repository:identity??repositoryIdentity(remote)};
}
export function contains(repo: string, head: string | null): boolean {
  if (!head || !/^[a-f0-9]{40,64}$/.test(head)) return false;
  try { git(repo,['merge-base','--is-ancestor',head,'HEAD']); return true; } catch { return false; }
}
