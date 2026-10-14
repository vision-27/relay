import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { VERSION } from '../core/version.js';
import { temporary } from './helpers.js';

const npm=process.env.npm_execpath;if(!npm)throw Error('Run npm run package:release');
const temp=temporary(),output=resolve('.relay/releases');mkdirSync(output,{recursive:true});
try{
  // npm publish --dry-run propagates its setting into lifecycle scripts. Build
  // the local archive even then; this command never uploads to a registry.
  const result=await promisify(execFile)(process.execPath,[npm,'pack','--dry-run=false','--ignore-scripts','--json','--pack-destination',temp.dir],{windowsHide:true,maxBuffer:2_000_000});
  const packed=JSON.parse(result.stdout)[0];
  for(const file of packed.files)assert.ok(/^(package\.json|README\.md|out\/(core|node)\/[^/]+\.js|next\/(EASY_SETUP|TROUBLESHOOTING|REMOTE_MCP|CLAUDE_CHANNEL)\.md)$/.test(file.path),'Unexpected package file: '+file.path);
  assert.ok(packed.files.some((file:{path:string})=>file.path==='out/node/remote-setup.js'));
  const name=`relay-${VERSION}.tgz`,target=join(output,name);copyFileSync(join(temp.dir,packed.filename),target);
  const sha256=createHash('sha256').update(readFileSync(target)).digest('hex');writeFileSync(target+'.sha256',sha256+'  '+name+'\n');
  console.log(JSON.stringify({artifact:target,sha256,files:packed.files.length,version:VERSION}));
}finally{temp.cleanup();}
