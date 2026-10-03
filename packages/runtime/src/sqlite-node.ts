import { DatabaseSync } from 'node:sqlite';
import { SqliteEventStore, type SqliteDatabase } from './store.js';

/** Synchronous node:sqlite binding adapted to the Runtime's injectable store contract. */
export class NodeSqliteDatabase implements SqliteDatabase {
  readonly database: DatabaseSync;
  private readonly filename: string;

  private static readonly transactionTails = new Map<string, Promise<void>>();

  constructor(filename: string) {
    this.filename = filename;
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  run(sql: string, params: readonly unknown[] = []): void {
    this.database.prepare(sql).run(...params as Array<null | number | bigint | string | NodeJS.ArrayBufferView>);
  }

  all<T>(sql: string, params: readonly unknown[] = []): T[] {
    return this.database.prepare(sql).all(...params as Array<null | number | bigint | string | NodeJS.ArrayBufferView>) as T[];
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = NodeSqliteDatabase.transactionTails.get(this.filename) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    NodeSqliteDatabase.transactionTails.set(this.filename, tail);
    await previous;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      release();
      if (NodeSqliteDatabase.transactionTails.get(this.filename) === tail) NodeSqliteDatabase.transactionTails.delete(this.filename);
    }
  }

  close(): void {
    this.database.close();
  }
}

export function openSqliteEventStore(filename: string): { store: SqliteEventStore; database: NodeSqliteDatabase } {
  const database = new NodeSqliteDatabase(filename);
  return { database, store: new SqliteEventStore(database) };
}
