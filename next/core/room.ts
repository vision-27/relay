import { assert, bounded, hash, id, paths, redact, RelayError, secret, stable, type EventInput, type GitState, type Member, type Receipt, type RelayEvent, type Session, type Sql } from './types.js';

export class Room {
  constructor(private sql: Sql) {
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, member_id TEXT NOT NULL, request TEXT NOT NULL, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS receipts (event_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(event_id,session_id))'
    ]) sql.exec(statement);
  }
  async authenticate(token: string): Promise<Member> {
    const found = this.sql.all<Member>('SELECT id,name,role FROM members WHERE token_hash=? AND revoked=0', await hash(token))[0];
    assert(found, 401, 'Connection expired or access revoked. Reconnect to Relay.');
    return found;
  }
  active(memberId:string):boolean { return !!this.sql.all('SELECT id FROM members WHERE id=? AND revoked=0',memberId).length; }
  async create(name: string, ownerName: string, repository: string) {
    const token = secret(), memberId = crypto.randomUUID(), tokenHash = await hash(token);
    this.sql.transaction(() => {
      assert(!this.sql.all('SELECT key FROM meta WHERE key=?', 'project').length, 409, 'Project already exists');
      this.sql.exec('INSERT INTO meta VALUES (?,?)', 'project', JSON.stringify({ name: bounded(name, 80), repository: bounded(repository, 500) }));
      this.sql.exec('INSERT INTO members (id,name,role,token_hash) VALUES (?,?,?,?)', memberId, bounded(ownerName, 80), 'owner', tokenHash);
    });
    return { token, memberId };
  }
  async invite(member: Member) {
    assert(member.role === 'owner', 403, 'Only the project owner can invite members');
    const code = secret(), expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    this.sql.exec('INSERT INTO invites VALUES (?,?,0)', await hash(code), expiresAt);
    return { code, expiresAt };
  }
  async join(code: string, name: string, repository: string) {
    const codeHash = await hash(bounded(code, 128)), token = secret(), tokenHash = await hash(token), memberId = crypto.randomUUID();
    this.sql.transaction(() => {
      const invite = this.sql.all<{expires:number;used:number}>('SELECT expires,used FROM invites WHERE hash=?', codeHash)[0];
      assert(invite && !invite.used && invite.expires > Date.now(), 403, 'Invitation is invalid, expired or already used');
      const project = this.project();
      assert(project.repository === repository, 409, 'This checkout is a different Git repository');
      this.sql.exec('UPDATE invites SET used=1 WHERE hash=?', codeHash);
      this.sql.exec('INSERT INTO members (id,name,role,token_hash) VALUES (?,?,?,?)', memberId, bounded(name, 80), 'member', tokenHash);
    });
    return { token, memberId, project: this.project() };
  }
  project(): {name:string;repository:string} {
    const row = this.sql.all<{value:string}>('SELECT value FROM meta WHERE key=?', 'project')[0];
    assert(row, 404, 'Project not found');
    return JSON.parse(row.value);
  }
  sessions(): Session[] { return this.sql.all<{data:string}>('SELECT data FROM sessions').map(r => JSON.parse(r.data)); }
  session(sessionId: string): Session {
    const row = this.sql.all<{data:string}>('SELECT data FROM sessions WHERE id=?', id(sessionId))[0];
    assert(row, 404, 'Session not found'); return JSON.parse(row.data);
  }
  own(member: Member, sessionId: string): Session {
    const session = this.session(sessionId); assert(session.memberId === member.id, 403, 'Session belongs to another member'); return session;
  }
  register(member: Member, input: Session) {
    const existing = this.sql.all<{member_id:string;data:string}>('SELECT member_id,data FROM sessions WHERE id=?', id(input.id))[0];
    assert(!existing || existing.member_id === member.id, 403, 'Session belongs to another member');
    assert(['codex','claude'].includes(input.provider), 400, 'Unsupported coding agent');
    assert(['active','idle','blocked','closed'].includes(input.state), 400, 'Invalid session state');
    if(input.state!=='closed'&&(!existing||JSON.parse(existing.data).state==='closed'))
      assert(this.sql.all<{n:number}>("SELECT count(*) AS n FROM sessions WHERE json_extract(data,'$.state')!='closed'")[0]!.n < 64, 429, 'Project active-session limit reached; close inactive sessions before adding more');
    assert(input.git && input.git.repository === this.project().repository, 409, 'Repository identity changed; reconnect explicitly');
    assert(JSON.stringify(input.git).length < 20_000, 413, 'Git metadata too large');
    const session: Session = { id: input.id, memberId: member.id, provider: input.provider, sourceId: id(input.sourceId),
      name: bounded(input.name, 80), task: redact(bounded(input.task, 1000, false)), scopes: paths(input.scopes),
      state: input.state, git: input.git, updatedAt: Number.isFinite(Date.parse(input.updatedAt)) ? new Date(Math.min(Date.now(),Date.parse(input.updatedAt))).toISOString() : new Date().toISOString() };
    this.sql.exec('INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', session.id, member.id, JSON.stringify(session));
    return session;
  }
  events(after = 0, limit = 200): RelayEvent[] {
    return this.sql.all<{seq:number;data:string}>('SELECT seq,data FROM events WHERE seq>? ORDER BY seq LIMIT ?', after, Math.min(200, limit)).map(r => ({...JSON.parse(r.data), seq:r.seq}));
  }
  event(eventId: string): RelayEvent {
    const row = this.sql.all<{seq:number;data:string}>('SELECT seq,data FROM events WHERE id=?', id(eventId))[0];
    assert(row, 404, 'Event not found'); return {...JSON.parse(row.data),seq:row.seq};
  }
  async append(member: Member, input: EventInput): Promise<RelayEvent> {
    const requestHash=await hash(stable(input));
    const session = this.own(member, input.sessionId);
    assert(['intent','decision','contract','observation','test','question','reply'].includes(input.kind), 400, 'Invalid event kind');
    const prior = this.sql.all<{member_id:string;request:string}>('SELECT member_id,request FROM events WHERE id=?', id(input.id))[0];
    if (prior) { assert(prior.member_id === member.id && prior.request===requestHash, 409, 'Event identifier reused with different contents'); return this.event(input.id); }
    const code=input.git??session.git;
    assert(code.repository===this.project().repository && typeof code.dirty==='boolean' && Array.isArray(code.files),400,'Invalid source code metadata');
    assert(JSON.stringify(code).length<20_000,413,'Source metadata too large');
    if (input.targetSessionId) this.session(input.targetSessionId);
    if (input.kind === 'question') assert(input.targetSessionId, 400, 'Choose a session to ask');
    if (input.kind === 'reply') {
      assert(input.replyTo, 400, 'Reply must reference a question');
      const question = this.event(input.replyTo);
      assert(question.kind === 'question' && question.targetSessionId === session.id, 403, 'Only the addressed session can answer');
      assert(input.targetSessionId === question.sessionId, 400, 'Reply must return to the asking session');
    }
    if (input.supersedes) {
      const previous = this.event(input.supersedes);
      assert(previous.memberId === member.id && previous.kind === input.kind, 403, 'Only supersede your own record of the same kind');
    }
    const event: Omit<RelayEvent,'seq'> = {
      id: input.id, sessionId: session.id, memberId: member.id, kind: input.kind,
      text: redact(bounded(input.text, 8000)), paths: paths(input.paths),
      ...(input.targetSessionId ? {targetSessionId:id(input.targetSessionId)} : {}),
      ...(input.replyTo ? {replyTo:id(input.replyTo)} : {}),
      ...(input.supersedes ? {supersedes:id(input.supersedes)} : {}),
      ...(input.evidence ? {evidence:redact(bounded(input.evidence, 3000))} : {}),
      urgent: input.urgent === true, createdAt: new Date().toISOString(), git: code,
      ...(input.occurredAt?{occurredAt:bounded(input.occurredAt,40)}:{})
    };
    this.sql.transaction(() => {
      this.sql.exec('INSERT INTO events(id,member_id,request,data) VALUES (?,?,?,?)', event.id, member.id, requestHash, JSON.stringify(event));
      if (event.targetSessionId) this.writeReceipt({eventId:event.id,sessionId:event.targetSessionId,state:'queued',detail:'Stored for recipient',updatedAt:event.createdAt});
      if (event.kind === 'reply') this.writeReceipt({eventId:event.replyTo!,sessionId:session.id,state:'answered',detail:'Reply recorded from addressed session',updatedAt:event.createdAt});
    });
    return this.event(event.id);
  }
  receipts(): Receipt[] { return this.sql.all<{data:string}>('SELECT data FROM receipts ORDER BY rowid DESC LIMIT 500').map(r => JSON.parse(r.data)); }
  receipt(member: Member, input: Receipt) {
    this.own(member, input.sessionId); const event = this.event(input.eventId);
    assert(event.targetSessionId === input.sessionId, 403, 'Receipt belongs to another recipient');
    assert(['accepted','delivered','uncertain','held'].includes(input.state), 400, 'Invalid delivery receipt');
    const row = this.sql.all<{data:string}>('SELECT data FROM receipts WHERE event_id=? AND session_id=?', input.eventId,input.sessionId)[0];
    const prior:Receipt|undefined = row ? JSON.parse(row.data) : undefined;
    if (prior && (prior.state === 'answered' || prior.state === 'delivered')) return prior;
    const receipt = {...input,detail:bounded(input.detail, 300, false),updatedAt:new Date().toISOString()};
    this.writeReceipt(receipt); return receipt;
  }
  private writeReceipt(receipt: Receipt) {
    this.sql.exec('INSERT INTO receipts VALUES (?,?,?) ON CONFLICT(event_id,session_id) DO UPDATE SET data=excluded.data', receipt.eventId,receipt.sessionId,JSON.stringify(receipt));
  }
  revoke(member: Member, memberId: string) {
    assert(member.role === 'owner' && member.id !== memberId, 403, 'Only the owner can revoke another member');
    this.sql.exec('UPDATE members SET revoked=1 WHERE id=?', id(memberId));
    for (const session of this.sessions().filter(s => s.memberId === memberId)) {
      session.state='closed'; this.sql.exec('UPDATE sessions SET data=? WHERE id=?', JSON.stringify(session),session.id);
    }
  }
  snapshot() { return { project:this.project(), sessions:this.sessions(), receipts:this.receipts(), members:this.sql.all<Member>('SELECT id,name,role FROM members WHERE revoked=0') }; }
}

export async function routeRoom(room: Room, request: Request, action: string, allowCreate = false): Promise<Response> {
  try {
    const mutating = request.method === 'POST';
    let body='{}';
    if(mutating && request.body){
      const reader=request.body.getReader(),decoder=new TextDecoder();let bytes=0;body='';
      try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;assert(bytes<=40_000,413,'Request too large');body+=decoder.decode(chunk.value,{stream:true});}body+=decoder.decode();}
      finally{reader.releaseLock();}
    }
    assert(body.length <= 40_000, 413, 'Request too large');
    const input = JSON.parse(body);
    let result: unknown;
    if (action === 'create' && mutating && allowCreate) result = await room.create(input.name,input.ownerName,input.repository);
    else if (action === 'join' && mutating) result = await room.join(input.code,input.name,input.repository);
    else {
      const member = await room.authenticate(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      if (action === 'snapshot' && !mutating) result = room.snapshot();
      else if (action === 'events' && !mutating) {
        const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
        assert(Number.isSafeInteger(after) && after >= 0, 400, 'Invalid replay cursor');
        result = {events:room.events(after)};
      } else if (action === 'events' && mutating) result = await room.append(member,input);
      else if (action === 'sessions' && mutating) result = room.register(member,input);
      else if (action === 'receipts' && mutating) result = room.receipt(member,input);
      else if (action === 'invite' && mutating) result = await room.invite(member);
      else if (action === 'revoke' && mutating) { room.revoke(member,input.memberId); result={ok:true}; }
      else throw new RelayError(404,'Route not found');
    }
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    const status = error instanceof RelayError ? error.status : error instanceof SyntaxError ? 400 : 500;
    return Response.json({error:status === 500 ? 'Relay could not complete the request' : (error as Error).message},{status});
  }
}
