// Build on the target OS. CI's setup-node supplies the matching Node runtime.
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { temporary } from './helpers.js';
import { installRuntime } from '../node/network-runtime.js';
import { VERSION } from '../core/version.js';

const execute=promisify(execFile),temp=temporary(),output=resolve('.relay/releases');
mkdirSync(output,{recursive:true});
try{
  const cli=installRuntime(resolve('out/node/cli.js'),join(temp.dir,'staging'));
  const root=resolve(dirname(cli),'../..');
  const engine=join(root,'engine');mkdirSync(engine);
  copyFileSync(process.execPath,join(engine,process.platform==='win32'?'node.exe':'node'));
  if(process.platform!=='win32')chmodSync(join(engine,'node'),0o755);
  const response=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Could not retrieve the bundled Node license');
  writeFileSync(join(engine,'LICENSE'),await response.text());
  const name=`RelaySetup-${VERSION}-${process.platform}-${process.arch}`;
  let artifact:string;
  if(process.platform==='win32'){
    const payload=join(temp.dir,'payload.zip');await execute('tar',['-a','-cf',payload,'-C',root,'.'],{windowsHide:true});
    const code=String.raw`using System;using System.Diagnostics;using System.IO;using System.IO.Compression;using System.Reflection;using System.Windows.Forms;
class RelaySetup {
 [STAThread] static int Main(string[] args) {
  bool smoke=args.Length==1&&args[0]=="--smoke-test";
  string folder=Path.Combine(Path.GetTempPath(),"RelaySetup-"+Guid.NewGuid().ToString("N"));
  try {
   Directory.CreateDirectory(folder);string prefix=Path.GetFullPath(folder)+Path.DirectorySeparatorChar;
   using(Stream stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("Relay.payload.zip"))
   using(ZipArchive zip=new ZipArchive(stream,ZipArchiveMode.Read)) {
    foreach(ZipArchiveEntry entry in zip.Entries) {
     string dest=Path.GetFullPath(Path.Combine(folder,entry.FullName));
     if(dest==Path.GetFullPath(folder))continue;
     if(!dest.StartsWith(prefix,StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid package path");
     if(entry.Name.Length==0){Directory.CreateDirectory(dest);continue;}
     Directory.CreateDirectory(Path.GetDirectoryName(dest));using(Stream input=entry.Open())using(Stream file=File.Create(dest))input.CopyTo(file);
    }
   }
   string node=Path.Combine(folder,"engine","node.exe"),cli=Path.Combine(folder,"out","node","cli.js");
   ProcessStartInfo info=new ProcessStartInfo(node,"\""+cli+"\" "+(smoke?"--version":"setup --remote --web"));
   info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;info.WorkingDirectory=folder;
   using(Process process=Process.Start(info)){string stdout=process.StandardOutput.ReadToEnd();string stderr=process.StandardError.ReadToEnd();process.WaitForExit();
    if(process.ExitCode!=0)throw new Exception("Relay could not start. Please download the installer again.");
    if(smoke&&stdout.Trim()!="${VERSION}")throw new Exception("Version check failed");
   }
   return 0;
  }catch(Exception error){if(!smoke)MessageBox.Show(error.Message,"Relay setup",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1;}
  finally {try{if(Path.GetFullPath(folder).StartsWith(Path.GetFullPath(Path.GetTempPath()),StringComparison.OrdinalIgnoreCase))Directory.Delete(folder,true);}catch{}}
 }
}`;
    const source=join(temp.dir,'RelaySetup.cs');writeFileSync(source,code);
    const compiler=join(process.env.WINDIR??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    artifact=join(output,name+'.exe');
    await execute(compiler,['/nologo','/target:winexe','/optimize+','/reference:System.Windows.Forms.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll','/resource:'+payload+',Relay.payload.zip','/out:'+artifact,source],{windowsHide:true,timeout:60000});
    // Exercise extraction and the bundled runtime through the actual double-click executable.
    await execute(artifact,['--smoke-test'],{windowsHide:true,timeout:60000});
  }else{
    const app=process.platform==='darwin'?'Relay Setup.app':'Relay Setup';
    const appRoot=join(temp.dir,app);
    const resources=process.platform==='darwin'?join(appRoot,'Contents','Resources'):appRoot;
    mkdirSync(resources,{recursive:true});cpSync(root,join(resources,'runtime'),{recursive:true});
    let launcher:string;
    if(process.platform==='darwin'){
      const macos=join(appRoot,'Contents','MacOS');mkdirSync(macos);
      writeFileSync(join(appRoot,'Contents','Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Relay Setup</string><key>CFBundleIdentifier</key><string>app.relayworkspace.setup</string><key>CFBundleName</key><string>Relay Setup</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>0.8.0</string><key>LSUIElement</key><true/></dict></plist>`);
      launcher=join(macos,'Relay Setup');
      writeFileSync(launcher,'#!/bin/sh\nbase=$(CDPATH= cd "$(dirname "$0")/../Resources/runtime" && pwd)\nif [ "$1" = "--smoke-test" ]; then exec "$base/engine/node" "$base/out/node/cli.js" --version; fi\nexec "$base/engine/node" "$base/out/node/cli.js" setup --remote --web\n',{mode:0o755});
    }else{
      launcher=join(appRoot,'Install Relay');
      writeFileSync(launcher,'#!/bin/sh\nbase=$(CDPATH= cd "$(dirname "$0")/runtime" && pwd)\nif [ "$1" = "--smoke-test" ]; then exec "$base/engine/node" "$base/out/node/cli.js" --version; fi\nexec "$base/engine/node" "$base/out/node/cli.js" setup --remote --web\n',{mode:0o755});
    }
    const copied=join(resources,'runtime'),node=join(copied,'engine','node');chmodSync(node,0o755);
    const result=await execute(node,[join(copied,'out','node','cli.js'),'--version']);if(result.stdout.trim()!==VERSION)throw new Error('Bundled runtime failed its check');
    const launchResult=await execute(launcher,['--smoke-test']);if(launchResult.stdout.trim()!==VERSION)throw new Error('Desktop launcher failed its check');
    artifact=join(output,name+'.tar.gz');await execute('tar',['-czf',artifact,'-C',temp.dir,app]);
  }
  const sha256=createHash('sha256').update(readFileSync(artifact)).digest('hex');
  writeFileSync(artifact+'.sha256',sha256+'  '+artifact.split(/[\\/]/).at(-1)+'\n');
  console.log(JSON.stringify({artifact,sha256,platform:process.platform,architecture:process.arch,node:process.version,signed:false,bundledRuntime:'passed'}));
}finally{temp.cleanup();}
