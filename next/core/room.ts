import { Collaboration } from './collaboration.js';
import { assert, bounded, hash, id, paths, redact, RelayError, secret, stable, type EventInput, type GitState, type Member, type Receipt, type RelayEvent, type Session, type Sql } from './types.js';

export class Room {
  readonly collaboration:Collaboration;
  constructor(private sql: Sql) {
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE IF NOT EXISTS membership_audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, member_id TEXT NOT NULL, old_role TEXT NOT NULL, new_role TEXT NOT NULL, created_at TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, member_id TEXT NOT NULL, request TEXT NOT NULL, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS receipts (event_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(event_id,session_id))'
    ]) sql.exec(statement);
    this.collaboration=new Collaboration(sql,this);
  }
  async authenticate(token: string): Promise<Member> {
    const found = this.sql.all<Member>('SELECT id,name,role FROM members WHERE token_hash=? AND revoked=0', await hash(token))[0];
    assert(found, 401, 'Connection expired or access revoked. Reconnect to Relay.');
    return found;
  }
  active(memberId:string):boolean { return !!this.sql.all('SELECT id FROM members WHERE id=? AND revoked=0',memberId).length; }
  async create(name: string, ownerName: string, repository: string, mode: 'repository'|'network' = 'repository') {
    assert(['repository','network'].includes(mode),400,'Invalid collaboration mode');
    const token = secret(), memberId = crypto.randomUUID(), tokenHash = await hash(token);
    this.sql.transaction(() => {
      assert(!this.sql.all('SELECT key FROM meta WHERE key=?', 'project').length, 409, 'Project already exists');
      this.sql.exec('INSERT INTO meta VALUES (?,?)', 'project', JSON.stringify({ name: bounded(name, 80), repository: bounded(repository, 500), mode }));
      this.sql.exec('INSERT INTO members (id,name,role,token_hash) VALUES (?,?,?,?)', memberId, bounded(ownerName, 80), 'owner', tokenHash);
    });
    return { token, memberId };
  }
  async invite(member: Member) {
    assert(member.role === 'owner' || member.role === 'admin', 403, 'Only the project owner or an admin can invite members');
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
      assert(project.mode === 'network' || project.repository === repository, 409, `This checkout is a different Git repository. Invitation: ${project.repository}; checkout: ${repository}. Connect from the matching checkout.`);
      this.sql.exec('UPDATE invites SET used=1 WHERE hash=?', codeHash);
      this.sql.exec('INSERT INTO members (id,name,role,token_hash) VALUES (?,?,?,?)', memberId, bounded(name, 80), 'member', tokenHash);
    });
    return { token, memberId, project: this.project() };
  }
  project(): {name:string;repository:string;mode?:'repository'|'network'} {
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
    assert(['codex','claude'].includes(input.provider)||(input.provider==='human'&&this.project().mode==='network'), 400, 'Unsupported coding agent');
    assert(['active','idle','blocked','closed'].includes(input.state), 400, 'Invalid session state');
    const network=this.project().mode==='network',cutoff=new Date(Date.now()-90_000).toISOString();
    if(input.state!=='closed'&&(!existing||JSON.parse(existing.data).state==='closed'||(network&&JSON.parse(existing.data).updatedAt<=cutoff)))
      assert(this.sql.all<{n:number}>("SELECT count(*) AS n FROM sessions WHERE json_extract(data,'$.state')!='closed' AND (?=0 OR json_extract(data,'$.updatedAt')>?)",network?1:0,cutoff)[0]!.n < 64, 429, 'Project active-session limit reached; close inactive sessions before adding more');
    assert(input.git && (this.project().mode==='network' || input.git.repository === this.project().repository), 409, 'Repository identity changed; reconnect explicitly');
    bounded(input.git.repository,500);
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
    assert(['intent','decision','contract','observation','test','question','reply','artifact','integration'].includes(input.kind), 400, 'Invalid event kind');
    const prior = this.sql.all<{member_id:string;request:string}>('SELECT member_id,request FROM events WHERE id=?', id(input.id))[0];
    if (prior) { assert(prior.member_id === member.id && prior.request===requestHash, 409, 'Event identifier reused with different contents'); return this.event(input.id); }
    const code=input.git??session.git;
    assert((this.project().mode==='network' ? typeof code.repository==='string'&&code.repository.length>0&&code.repository.length<=500 : code.repository===this.project().repository) && typeof code.dirty==='boolean' && Array.isArray(code.files),400,'Invalid source code metadata');
    if(this.project().mode==='network')assert(['question','reply'].includes(input.kind),403,'Networks share directed questions and replies only');
    assert(JSON.stringify(code).length<20_000,413,'Source metadata too large');
    if (input.targetSessionId) assert(this.active(this.session(input.targetSessionId).memberId),403,'Recipient access revoked');
    if(input.phase!==undefined)assert(['progress','final'].includes(input.phase),400,'Invalid phase');
    if(input.artifactId){const artifact=this.collaboration.artifact(input.artifactId);assert(artifact.sealed,409,'Artifact is not ready');}
    if(input.kind==='artifact')assert(input.artifactId,400,'Artifact reference required');
    if (input.kind === 'question') assert(input.targetSessionId, 400, 'Choose a session to ask');
    if (input.kind === 'reply') {
      if(input.phase==='final')assert(!this.sql.all("SELECT id FROM events WHERE json_extract(data,'$.replyTo')=? AND json_extract(data,'$.phase')='final'",input.replyTo??'').length,409,'Final answer already recorded; publish an explicit progress update for corrections');
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
      ...(input.phase?{phase:input.phase}:{}),...(input.artifactId?{artifactId:input.artifactId}:{}),
      urgent: input.urgent === true, createdAt: new Date().toISOString(), git: code,
      ...(input.occurredAt?{occurredAt:bounded(input.occurredAt,40)}:{})
    };
    this.sql.transaction(() => {
      this.sql.exec('INSERT INTO events(id,member_id,request,data) VALUES (?,?,?,?)', event.id, member.id, requestHash, JSON.stringify(event));
      if (event.targetSessionId) this.writeReceipt({eventId:event.id,sessionId:event.targetSessionId,state:'queued',detail:'Stored for recipient',updatedAt:event.createdAt});
      if(event.kind==='reply'&&event.phase==='progress')this.receipt(member,{eventId:event.replyTo!,sessionId:session.id,state:'delivered',detail:'Progress reply received',updatedAt:event.createdAt});
      if (event.kind === 'reply'&&event.phase!=='progress') this.writeReceipt({eventId:event.replyTo!,sessionId:session.id,state:'answered',detail:'Reply recorded from addressed session',updatedAt:event.createdAt});
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
  setMemberRole(member: Member, memberId: string, role: unknown): Member {
    assert(member.role === 'owner', 403, 'Only the project owner can change member roles');
    assert(role === 'admin' || role === 'member', 400, 'Role must be admin or member');
    return this.sql.transaction(() => {
      const target = this.sql.all<Member>('SELECT id,name,role FROM members WHERE id=? AND revoked=0', id(memberId))[0];
      assert(target, 404, 'Active member not found');
      assert(target.role !== 'owner' && target.id !== member.id, 403, 'Project ownership cannot be changed here');
      if (target.role !== role) {
        this.sql.exec('UPDATE members SET role=? WHERE id=?', role, target.id);
        this.sql.exec('INSERT INTO membership_audit VALUES (?,?,?,?,?,?)', crypto.randomUUID(), member.id, target.id, target.role, role, new Date().toISOString());
      }
      return {...target, role};
    });
  }
  revoke(member: Member, memberId: string) {
    const target = this.sql.all<Member>('SELECT id,name,role FROM members WHERE id=? AND revoked=0', id(memberId))[0];
    assert(target, 404, 'Active member not found');
    assert(member.id !== memberId && (member.role === 'owner' || (member.role === 'admin' && target.role === 'member')), 403, 'Only the owner can revoke admins; admins may revoke ordinary members');
    this.sql.exec('UPDATE members SET revoked=1 WHERE id=?', id(memberId));
    for (const session of this.sessions().filter(s => s.memberId === memberId)) {
      session.state='closed'; this.sql.exec('UPDATE sessions SET data=? WHERE id=?', JSON.stringify(session),session.id);
    }
  }
  snapshot() { return { protocol:2,acceptedRevision:this.collaboration.accepted(),tasks:this.collaboration.tasks(),project:this.project(), sessions:this.sessions(), receipts:this.receipts(), members:this.sql.all<Member>('SELECT id,name,role FROM members WHERE revoked=0') }; }
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
    if (action === 'create' && mutating && allowCreate) result = await room.create(input.name,input.ownerName,input.repository,input.mode);
    else if (action === 'join' && mutating) result = await room.join(input.code,input.name,input.repository);
    else {
      const member = await room.authenticate(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      if(room.project().mode==='network')assert(!['integrations','taskarchive','tasks','artifacts'].includes(action),403,'Repository operations are unavailable in a network');
      if (action === 'snapshot' && !mutating) result = room.snapshot();
      else if (action === 'events' && !mutating) {
        const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
        assert(Number.isSafeInteger(after) && after >= 0, 400, 'Invalid replay cursor');
        result = {events:room.events(after)};
      } else if (action === 'events' && mutating) result = await room.append(member,input);
      else if (action === 'sessions' && mutating) result = room.register(member,input);
      else if (action === 'receipts' && mutating) result = room.receipt(member,input);
      else if(action==='integrations'&&mutating)result=room.collaboration.integrate(member,input);
      else if(action==='taskarchive'&&mutating)result=room.collaboration.archiveTask(member,input);
      else if(action==='tasks')result=mutating?room.collaboration.mutateTask(member,input):{tasks:room.collaboration.tasks(),acceptedRevision:room.collaboration.accepted()};
      else if(action==='artifacts'){const query=new URL(request.url).searchParams;result=mutating?await room.collaboration.mutateArtifact(member,input):query.has('id')?(query.has('part')?room.collaboration.chunk(query.get('id')!,Number(query.get('part'))):room.collaboration.artifact(query.get('id')!)):{artifacts:room.collaboration.artifacts()};}
      else if (action === 'invite' && mutating) result = await room.invite(member);
      else if (action === 'members' && mutating) result = room.setMemberRole(member,input.memberId,input.role);
      else if (action === 'revoke' && mutating) { room.revoke(member,input.memberId); result={ok:true}; }
      else throw new RelayError(404,'Route not found');
    }
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  } catch (error) {
    const status = error instanceof RelayError ? error.status : error instanceof SyntaxError ? 400 : 500;
    return Response.json({error:status === 500 ? 'Relay could not complete the request' : (error as Error).message},{status});
  }
}
