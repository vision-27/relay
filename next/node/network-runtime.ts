import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export function assertRealPath(path:string) {
  let current=resolve(path);
  while(true){
    if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error(`Relay will not install through a symlink: ${current}`);
    const parent=dirname(current);if(parent===current)return;current=parent;
  }
}

export function runtimeNode(cli:string):string {
  const bundled=resolve(dirname(cli),'../../engine',process.platform==='win32'?'node.exe':'node');
  return existsSync(bundled)?bundled:process.execPath;
}

// Keep the installed MCP independent of npx caches, extracted tarballs, and checkouts.
// Desktop bundles carry Node too; npm installs reuse the user's installed runtime.
export function installRuntime(cli:string,dir:string):string {
  const source=resolve(dirname(cli),'../..');
  const pkg=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
  if(!['@platys/relay','@relay-workspace/cli'].includes(pkg.name)||!/^\d+\.\d+\.\d+[a-zA-Z0-9.+-]*$/.test(pkg.version))throw new Error('Not a Relay package');
  const files=new Map<string,Buffer>();
  const collect=(folder:string,target:string)=>{
    for(const item of readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=join(folder,item.name),relative=target+'/'+item.name;
      if(item.isSymbolicLink())throw new Error('Relay runtime contains a symlink');
      if(item.isDirectory())collect(path,relative);
      else if(item.isFile())files.set(relative,readFileSync(path));
    }
  };
  collect(join(source,'out','core'),'out/core');collect(join(source,'out','node'),'out/node');
  const bundledNode=join(source,'engine',process.platform==='win32'?'node.exe':'node');
  if(existsSync(bundledNode))collect(join(source,'engine'),'engine');
  // Resolve each runtime dependency from the package being installed, including transitive deps.
  const dependencies=new Map<string,string>();
  const collectDependencies=(manifest:any,from:string)=>{
    for(const name of Object.keys(manifest.dependencies??{}).sort()){
      const path=createRequire(join(from,'package.json')).resolve(name+'/package.json');
      const dependency=JSON.parse(readFileSync(path,'utf8'));
      if(dependencies.has(name)){
        if(dependencies.get(name)!==dependency.version)throw new Error('Relay runtime needs nested dependency packaging: '+name);
        continue;
      }
      dependencies.set(name,dependency.version);collect(dirname(path),'node_modules/'+name);
      collectDependencies(dependency,dirname(path));
    }
  };
  collectDependencies(pkg,source);
  files.set('package.json',Buffer.from(JSON.stringify({name:pkg.name,version:pkg.version,type:'module',private:true,dependencies:pkg.dependencies})));
  const hash=createHash('sha256');
  for(const [name,data] of [...files].sort(([a],[b])=>a.localeCompare(b)))hash.update(name+'\0'+data.length+'\0').update(data);
  const base=join(resolve(dir),'runtime'),target=join(base,pkg.version+'-'+hash.digest('hex'));
  assertRealPath(target);
  const verify=()=>{for(const [name,data] of files){const path=join(target,name);assertRealPath(path);if(!existsSync(path)||!readFileSync(path).equals(data))throw new Error('Installed Relay runtime is incomplete or changed; remove its version directory and run setup again');}};
  if(existsSync(target)){verify();return join(target,'out','node','cli.js');}
  mkdirSync(base,{recursive:true,mode:0o700});
  const stage=join(base,'.install-'+crypto.randomUUID());mkdirSync(stage,{mode:0o700});
  for(const [name,data] of files){const path=join(stage,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,data,{mode:0o600});}
  if(process.platform!=='win32'&&files.has('engine/node'))chmodSync(join(stage,'engine','node'),0o700);
  renameSync(stage,target);verify();return join(target,'out','node','cli.js');
}
