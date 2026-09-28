// Operator convenience for a deployment configured on this machine. The key is
// passed only to the owned CLI child, never printed or written to shell history.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { serverURL } from './client.js';
import { root } from './git.js';
try {
  const {values}=parseArgs({options:{provider:{type:'string'},name:{type:'string'},repo:{type:'string'},help:{type:'boolean'},'no-start':{type:'boolean'},'no-install':{type:'boolean'}}});
  if(values.help){
    console.log('Connect using this checkout\'s saved hosted-service credentials.\n  npm run connect:hosted -- --provider codex|claude|both [--name NAME] [--repo PATH]\nCreates or resumes a project connection and installs repository hooks through relay-next connect.');
  }else{
    const deployment=JSON.parse(readFileSync(resolve('.relay/cloudflare-deployment.json'),'utf8'));
    const key=JSON.parse(readFileSync(resolve('.relay/cloudflare-secrets.json'),'utf8')).RELAY_CREATE_KEY;
    if(typeof key!=='string'||key.length<32)throw new Error('The saved operator key is unavailable');
    const server=serverURL(deployment.server),existingPath=join(root(values.repo??process.cwd()),'.relay','next','connection.json');
    const args=['connect'];
    if(existsSync(existingPath)){
      if(serverURL(JSON.parse(readFileSync(existingPath,'utf8')).server)!==server)throw new Error('This repository is connected to a different Relay service');
    }else args.push('--server',server);
    for(const [name,value] of Object.entries(values))if(value===true)args.push(`--${name}`);else if(typeof value==='string')args.push(`--${name}`,value);
    const child=spawn(process.execPath,[fileURLToPath(new URL('./cli.js',import.meta.url)),...args],{stdio:'inherit',windowsHide:true,shell:false,env:{...process.env,RELAY_CREATE_KEY:key}});
    child.once('error',()=>{console.error('Could not start the Relay connection command');process.exitCode=1;});
    child.once('exit',code=>{process.exitCode=code??1;});
  }
}catch(error){console.error(`Relay hosted connection: ${(error as Error).message}`);process.exitCode=1;}
