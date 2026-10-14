import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardPage } from '../core/dashboard-page.js';

// Run the shipped client script with a small DOM double to control pending HTTP
// responses. Visual layout and browser behavior are checked separately in QA.
class Element {
  value='';textContent='';hidden=false;disabled=false;checked=false;open=false;
  scrollHeight=0;scrollTop=0;clientHeight=0;children:Element[]=[];
  onclick:any;onsubmit:any;onchange:any;oninput:any;
  classList={toggle(){}};
  append(...children:Element[]){this.children.push(...children);}
  replaceChildren(...children:Element[]){this.children=children;this.value='';this.textContent='';}
  setAttribute(){} focus(){} addEventListener(){} select(){}
  close(){this.open=false;}showModal(){this.open=true;}
}
async function client(fetcher:(url:string,init:RequestInit)=>Promise<Response>){
  const html=await dashboardPage().text(),script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]!;
  const elements=new Map<string,Element>(),get=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
  const storage=new Map<string,string>();
  const document={hidden:true,getElementById:get,createElement:()=>new Element(),addEventListener(){}};
  const sessionStorage={getItem:(key:string)=>storage.get(key),setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)};
  const run=new Function('document','sessionStorage','location','history','fetch','Option','setInterval','clearInterval','setTimeout','clearTimeout',script+'\nreturn {begin};');
  const app=run(document,sessionStorage,{origin:'https://relay.test',hash:''},{},fetcher,Element,()=>0,()=>{},()=>0,()=>{});
  return {app,get,storage};
}
const alice={projectId:'alpha',token:'a'.repeat(64)},bob={projectId:'beta',token:'b'.repeat(64)};
const snapshot={project:{name:'QA'},member:{id:'member',name:'Member',role:'member'},members:[],sessions:[],events:[],receipts:[],more:false,cursor:0,oldest:0};
const page=()=>Response.json(snapshot);

test('sign-out clears private drafts, recipient, reply controls and displayed room data before another login',async()=>{
  const {app,get,storage}=await client(async()=>page());await app.begin(alice);
  get('message').value='Private unsent draft';get('target').value='old-agent';get('search').value='private filter';get('show-closed').checked=true;
  get('feed').append(new Element());get('cancel-reply').hidden=false;get('banner').textContent='Old message status';
  get('signout').onclick();
  assert.equal(storage.has('relay-room'),false);assert.equal(get('message').value,'');assert.equal(get('target').value,'');assert.equal(get('feed').children.length,0);assert.equal(get('banner').textContent,'');
  await app.begin(bob);
  assert.equal(get('message').value,'');assert.equal(get('search').value,'');assert.equal(get('show-closed').checked,false);assert.equal(get('cancel-reply').hidden,true);assert.equal(get('send').disabled,true);
});

test('an old send response cannot clear a new member draft or update their status',async()=>{
  let finish!:(r:Response)=>void;
  const {app,get}=await client(async(_url,init)=>JSON.parse(String(init.body)).operation==='send'?new Promise(resolve=>{finish=resolve;}):page());
  await app.begin(alice);get('message').value='Old message';get('target').value='old-agent';
  const sending=get('composer').onsubmit({preventDefault(){}});
  get('signout').onclick();await app.begin(bob);get('message').value='New private draft';
  finish(Response.json({event:{id:'old'}}));await sending;
  assert.equal(get('message').value,'New private draft');assert.equal(get('banner').textContent,'');
});

test('an old unauthorized response cannot stop a new room connection',async()=>{
  let finish!:(r:Response)=>void;
  const {app,get}=await client(async(url)=>url.includes('/alpha/')?new Promise(resolve=>{finish=resolve;}):page());
  const oldLogin=app.begin(alice);await app.begin(bob);
  finish(Response.json({error:'Old access revoked'},{status:401}));await oldLogin;
  assert.equal(get('banner').textContent,'');assert.notEqual(get('connection-state').textContent,'Access unavailable');
  assert.equal(get('room-name').textContent,'QA');
});
