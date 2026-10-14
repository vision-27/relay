export type Provider = 'codex' | 'claude';
export type Kind = 'intent' | 'decision' | 'contract' | 'observation' | 'test' | 'question' | 'reply' | 'artifact' | 'integration';
export type DeliveryState = 'queued' | 'accepted' | 'delivered' | 'answered' | 'uncertain' | 'held';
export interface GitState {
  head: string | null; branch: string | null; dirty: boolean;
  files: string[]; fingerprint: string; repository: string;
}
export interface Session {
  id: string; memberId: string; provider: Provider | 'human'; sourceId: string; name: string;
  task: string; scopes: string[]; git: GitState; state: 'active' | 'idle' | 'blocked' | 'closed';
  updatedAt: string;
}
export interface EventInput {
  id: string; sessionId: string; kind: Kind; text: string; paths: string[];
  targetSessionId?: string; replyTo?: string; supersedes?: string;
  evidence?: string; urgent?: boolean; phase?: 'progress'|'final'; artifactId?:string;
  git?: GitState; occurredAt?:string;
}
export interface RelayEvent extends EventInput {
  seq: number; memberId: string; createdAt: string; git: GitState;
}
export interface Receipt {
  eventId: string; sessionId: string; state: DeliveryState; detail: string; updatedAt: string;
}
export interface Member { id: string; name: string; role: 'owner' | 'admin' | 'member' }
export interface Sql {
  all<T extends object = Record<string, unknown>>(sql: string, ...values: (string | number | null)[]): T[];
  exec(sql: string, ...values: (string | number | null)[]): void;
  transaction<T>(body: () => T): T;
}
export class RelayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new RelayError(status, message);
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new RelayError(400, 'Invalid identifier');
  return value;
}
export function bounded(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new RelayError(400, `Expected text of at most ${max} characters`);
  return value;
}
export function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new RelayError(400, 'Expected at most 50 relative paths');
  return value.map(v => {
    const p = bounded(v, 300).replaceAll('\\', '/');
    if (p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..')) throw new RelayError(400, 'Paths must be relative to the repository');
    return p;
  });
}
export const fresh = (session: Session, now = Date.now()) => session.state !== 'closed' && now - Date.parse(session.updatedAt) < 90_000;
export const overlap = (a: string, b: string) => a === b || a.startsWith(b.replace(/\/$/, '') + '/') || b.startsWith(a.replace(/\/$/, '') + '/');
export function redact(text: string): string {
  text=text.replace(/\brelay_session_[a-f0-9]{64}\b/g,'[REDACTED SESSION KEY]');
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9_.+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}
export async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
}
export const secret = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
export function stable(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
  return JSON.stringify(value);
}
