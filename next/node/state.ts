import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SQLite } from './sqlite.js';
import type { EventInput, RelayEvent, Session } from '../core/types.js';
export interface Connection { server:string; projectId:string; memberId:string; token:string; repository:string; name:string; repo:string; mode?:'repository'|'network' }
export interface Binding extends Session { workspace?:string; sessionKey?:string; endpoint?:string; inboxToken?:string; transcriptPath?:string; hookSeenAt?:number; terminal?:{kind:'cmux'|'wmux';surface:string;workspace?:string;socket?:string;token?:string}; }
export interface Job { id:string; action:string; body:unknown }
export class State {
  readonly sql: SQLite;
  constructor(readonly dir:string) {
    mkdirSync(dir,{recursive:true,mode:0o700}); this.sql=new SQLite(join(dir,'state.sqlite3'));
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,action TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS cache(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,data TEXT NOT NULL)',
      "CREATE INDEX IF NOT EXISTS cache_target ON cache(json_extract(data,'$.targetSessionId'),seq)",
      'CREATE TABLE IF NOT EXISTS current_context(id TEXT PRIMARY KEY,data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS supersessions(previous_id TEXT PRIMARY KEY,replacement_id TEXT NOT NULL)',
      'CREATE VIRTUAL TABLE IF NOT EXISTS history_search USING fts5(event_id UNINDEXED, text, paths)',
      'CREATE TABLE IF NOT EXISTS delivery(event_id TEXT NOT NULL,session_id TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(event_id,session_id))',
      'CREATE TABLE IF NOT EXISTS metrics(name TEXT PRIMARY KEY,count INTEGER NOT NULL,chars INTEGER NOT NULL,bytes INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS supplied(session_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(session_id,event_id))'
    ]) this.sql.exec(statement);
  }
  measure(name:string,value:string){this.sql.exec('INSERT INTO metrics VALUES (?,1,?,?) ON CONFLICT(name) DO UPDATE SET count=count+1,chars=chars+excluded.chars,bytes=bytes+excluded.bytes',name,value.length,Buffer.byteLength(value));}
  metrics(){return this.sql.all('SELECT name,count,chars,bytes FROM metrics ORDER BY name');}
  get<T>(key:string):T|undefined { const row=this.sql.all<{value:string}>('SELECT value FROM kv WHERE key=?',key)[0]; return row?JSON.parse(row.value):undefined; }
  set(key:string,value:unknown) { this.sql.exec('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify(value)); }
  bindings(): Binding[] { return this.sql.all<{data:string}>('SELECT data FROM bindings').map(r=>JSON.parse(r.data)); }
  binding(sessionId:string):Binding {
    const result=this.bindings().find(s=>s.id===sessionId); if (!result) throw new Error('This session is not connected to this repository. Run relay-next connect and resume the coding session.'); return result;
  }
  bind(binding:Binding) { this.sql.exec('INSERT INTO bindings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',binding.id,JSON.stringify(binding)); }
  enqueue(action:string,body:unknown,key:string=crypto.randomUUID()) {
    if(action==='receipts'){
      const previous=this.sql.all<{body:string}>('SELECT body FROM outbox WHERE id=?',key)[0];
      if(previous&&['delivered','answered'].includes(JSON.parse(previous.body).state))return key;
    }
    this.sql.exec('INSERT INTO outbox VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',key,action,JSON.stringify(body),Date.now()); return key;
  }
  pending():Job[] { return this.sql.all<{id:string;action:string;body:string}>('SELECT id,action,body FROM outbox ORDER BY created,rowid LIMIT 100').map(r=>({...r,body:JSON.parse(r.body)})); }
  remove(jobId:string) { this.sql.exec('DELETE FROM outbox WHERE id=?',jobId); }
  cache(events:RelayEvent[]) {
    this.sql.transaction(()=>{
      for (const event of events) {
        const known=this.sql.all('SELECT id FROM cache WHERE id=?',event.id).length;
        this.sql.exec('INSERT INTO cache VALUES (?,?,?) ON CONFLICT(id) DO NOTHING',event.seq,event.id,JSON.stringify(event));
        if(!known){
          this.sql.exec('INSERT INTO history_search VALUES (?,?,?)',event.id,event.text,event.paths.join(' '));
          if(event.supersedes){this.sql.exec('DELETE FROM current_context WHERE id=?',event.supersedes);this.sql.exec('INSERT OR REPLACE INTO supersessions VALUES (?,?)',event.supersedes,event.id);}
          if(['decision','contract'].includes(event.kind))this.sql.exec('INSERT OR IGNORE INTO current_context VALUES (?,?)',event.id,JSON.stringify(event));
        }
      }
      if (events.length) this.set('cursor',Math.max(this.get<number>('cursor')??0,...events.map(e=>e.seq)));
    });
  }
  events():RelayEvent[] { return this.sql.all<{data:string}>('SELECT data FROM cache ORDER BY seq DESC LIMIT 2000').map(r=>JSON.parse(r.data)).reverse(); }
  event(eventId:string):RelayEvent|undefined {const row=this.sql.all<{data:string}>('SELECT data FROM cache WHERE id=?',eventId)[0];return row?JSON.parse(row.data):undefined;}
  decisions():RelayEvent[]{return this.sql.all<{data:string}>('SELECT data FROM current_context ORDER BY rowid DESC LIMIT 500').map(r=>JSON.parse(r.data));}
  superseded(eventId:string):boolean{return !!this.sql.all('SELECT 1 FROM supersessions WHERE previous_id=?',eventId).length;}
  search(query:string):RelayEvent[]{
    const terms=query.match(/[\p{L}\p{N}_]+/gu)?.slice(0,12).map(t=>'"'+t+'"').join(' OR ');if(!terms)return [];
    return this.sql.all<{data:string}>('SELECT c.data FROM history_search h JOIN cache c ON c.id=h.event_id WHERE history_search MATCH ? ORDER BY rank LIMIT 100',terms).map(r=>JSON.parse(r.data));
  }
  messages(sessionId:string):RelayEvent[]{return this.sql.all<{data:string}>("SELECT c.data FROM cache c LEFT JOIN delivery d ON d.event_id=c.id AND d.session_id=? WHERE json_extract(c.data,'$.targetSessionId')=? AND (json_extract(c.data,'$.phase') IS NULL OR json_extract(c.data,'$.phase')!='progress' OR json_extract(c.data,'$.urgent')=1) AND (d.state IS NULL OR d.state='held') ORDER BY c.seq LIMIT 50",sessionId,sessionId).map(r=>JSON.parse(r.data));}
  delivery(eventId:string,sessionId:string) { return this.sql.all<{state:string;detail:string}>('SELECT state,detail FROM delivery WHERE event_id=? AND session_id=?',eventId,sessionId)[0]; }
  mark(eventId:string,sessionId:string,status:string,detail='') {
    const previous=this.delivery(eventId,sessionId);
    if(previous && (previous.state==='answered'||previous.state==='delivered') && status!=='answered')return;
    this.sql.exec('INSERT INTO delivery VALUES (?,?,?,?) ON CONFLICT(event_id,session_id) DO UPDATE SET state=excluded.state,detail=excluded.detail',eventId,sessionId,status,detail);
  }
  supplied(sessionId:string,eventId:string) { return !!this.sql.all('SELECT 1 FROM supplied WHERE session_id=? AND event_id=?',sessionId,eventId).length; }
  supply(sessionId:string,eventId:string) { this.sql.exec('INSERT OR IGNORE INTO supplied VALUES (?,?)',sessionId,eventId); }
  publish(event:EventInput) {
    const captured={...event,git:event.git??this.binding(event.sessionId).git,occurredAt:event.occurredAt??new Date().toISOString()};
    this.enqueue('events',captured,event.id); return {eventId:event.id,status:'pending_sync'};
  }
  close() { this.sql.close(); }
}
export function stateDir(repo:string) { return join(resolve(repo),'.relay','next'); }
export function loadConnection(dir:string):Connection {
  const path=join(dir,'connection.json'); if(!existsSync(path)) throw new Error('This repository is not connected. Run relay-next connect.');
  return JSON.parse(readFileSync(path,'utf8'));
}
export function saveConnection(dir:string,config:Connection) {
  mkdirSync(dir,{recursive:true,mode:0o700}); const temp=join(dir,`connection.${crypto.randomUUID()}.tmp`), target=join(dir,'connection.json');
  writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600}); renameSync(temp,target);
  if(process.platform!=='win32') chmodSync(target,0o600);
}
export function publicSession(binding:Binding):Session {
  const {endpoint:_,inboxToken:__,transcriptPath:___,hookSeenAt:____,terminal:_____,workspace:______,sessionKey:_______,...session}=binding; return session;
}
