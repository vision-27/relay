import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { setupPage } from './setup-page.js';
import { setupNetwork, detectClients } from './network-setup.js';
import { networkDir } from './network-state.js';
import { loadConnection } from './state.js';
import { launchRemoteClaude, remoteSetupDir, setupRemote } from './remote-setup.js';

type Options=Record<string,string|boolean|undefined>;
export async function startSetupWeb(values:Options,cli:string,execute:(...args:Parameters<typeof setupNetwork>)=>Promise<Awaited<ReturnType<typeof setupNetwork>>|Awaited<ReturnType<typeof setupRemote>>>=values.remote?setupRemote:setupNetwork,launch=launchRemoteClaude){
  const dir=resolve(typeof values.dir==='string'?values.dir:values.remote?remoteSetupDir():networkDir());
  const existing=existsSync(join(dir,'connection.json'))?loadConnection(dir):undefined;
  const token=randomBytes(32).toString('base64url');
  let finish:()=>void=()=>{};
  const completedSetup=new Promise<void>(done=>{finish=done;});
  let origin='',busy=false,completed=false;
  let installed:Awaited<ReturnType<typeof setupRemote>>|undefined,launched=false;
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
    const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.headers.host!==origin.slice('http://'.length)||(req.headers.origin&&req.headers.origin!==origin)){json(403,{error:'Open setup using the link from the Relay installer.'});return;}
    if(req.method==='GET'&&req.url==='/'){
      const nonce=randomBytes(18).toString('base64url');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`});res.end(setupPage(nonce));return;
    }
    if(req.headers.authorization!=='Bearer '+token){json(403,{error:'Reopen the Relay installer to continue setup.'});return;}
    if(req.method==='GET'&&req.url==='/api/status'){
      json(200,{clients:detectClients(),name:existing?.name??userInfo().username,connected:!!existing,remote:!!values.remote,invitation:typeof values.invite==='string'?values.invite:''});return;
    }
    if(req.method==='POST'&&req.url==='/api/launch'){
      if(!installed?.launcher){json(409,{error:'Connect Claude Code first.'});return;}
      if(launched){json(200,{launched:true});return;}
      launched=true;
      try{await launch(installed.launcher);json(200,{launched:true});}catch{launched=false;json(400,{error:'Open the Claude with Relay shortcut on your desktop. Make sure Claude Code is installed.'});}return;
    }
    if(req.method!=='POST'||req.url!=='/api/setup'){json(404,{error:'Not found'});return;}
    const result=()=>({connected:true,...(installed?{remote:true,providers:installed.providers,canLaunch:!!installed.launcher,roomURL:installed.roomURL}:{})});
    if(completed){json(200,result());return;}
    if(busy){json(409,{error:'Setup is already running. Please wait.'});return;}
    busy=true;
    try{
      if(req.headers['content-type']!=='application/json')throw new Error('Send a JSON setup request.');
      let body='';for await(const chunk of req){body+=chunk;if(body.length>16000)throw new Error('The invitation is too long.');}
      const input=JSON.parse(body);
      if(typeof input.name!=='string'||(!existing&&!input.name.trim())||input.name.length>80||typeof input.invitation!=='string'||!['auto','codex','claude','both'].includes(input.provider))throw new Error('Enter your name and a valid Relay invitation.');
      if(!existing&&!input.invitation.trim())throw new Error('Paste the Relay invitation from your friend.');
      const configured=await execute({...values,dir,provider:input.provider,...(!existing?{name:input.name.trim(),invite:input.invitation.trim()}: {})},cli,{interactive:false,ask:async()=>{throw new Error('Setup needs additional information.');},log:()=>{}});
      if('remote' in configured)installed=configured as typeof installed;
      completed=true;json(200,result());finish();
    }catch(error){json(400,{error:error instanceof SyntaxError?'The setup request was not valid.':(error as Error).message});}
    finally{busy=false;}
  });
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);done();});});
  origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  return {url:origin+'/#'+token,completed:completedSetup,close:()=>new Promise<void>((done,reject)=>{server.close(error=>error?reject(error):done());server.closeIdleConnections();})};
}

export async function openSetupWeb(values:Options,cli:string){
  const web=await startSetupWeb(values,cli);
  console.log(`Finish setting up Relay in your browser:\n${web.url}`);
  if(!values['no-open']){
    const executable=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
    const args=process.platform==='win32'?['url.dll,FileProtocolHandler',web.url]:[web.url];
    const child=spawn(executable,args,{windowsHide:true,stdio:'ignore'});child.on('error',()=>console.error('Open the setup link above in your browser.'));child.unref();
  }
  let stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;clearTimeout(timer);process.off('SIGINT',stop);process.off('SIGTERM',stop);void web.close();};
  const timer=setTimeout(stop,15*60_000);timer.unref();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  if(!values.remote)void web.completed.then(()=>{const finished=setTimeout(stop,10000);finished.unref();});
}
