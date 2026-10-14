import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Sql } from '../core/types.js';
export class SQLite implements Sql {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true,mode:0o700});
    this.db = new DatabaseSync(path);
    try { this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL'); }
    catch(error) { this.db.close(); throw error; }
  }
  all<T extends object = Record<string,unknown>>(sql: string, ...values:(string|number|null)[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
  exec(sql: string, ...values:(string|number|null)[]) { this.db.prepare(sql).run(...values); }
  transaction<T>(body:()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=body(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
