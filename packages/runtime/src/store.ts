import { makeEvent, reduceRunEvents } from './events.js';
import type { DomainEvent, EventStore, ID, NewDomainEvent, Run } from './types.js';

export class InMemoryEventStore implements EventStore {
  private readonly events: DomainEvent[] = [];
  private readonly byRun = new Map<ID, DomainEvent[]>();
  private sequence = 0;
  private eventId = 0;

  async append(input: NewDomainEvent): Promise<DomainEvent> {
    const event = makeEvent(`evt-${++this.eventId}`, ++this.sequence, input, new Date().toISOString());
    this.events.push(event);
    if (event.runId) {
      const events = this.byRun.get(event.runId) ?? [];
      events.push(event);
      this.byRun.set(event.runId, events);
    }
    return event;
  }

  async appendMany(inputs: NewDomainEvent[]): Promise<DomainEvent[]> {
    const result: DomainEvent[] = [];
    for (const input of inputs) result.push(await this.append(input));
    return result;
  }

  async list(runId: ID): Promise<DomainEvent[]> {
    return [...(this.byRun.get(runId) ?? [])];
  }

  async listAll(): Promise<DomainEvent[]> {
    return [...this.events];
  }

  replayRun(runId: ID): Run {
    return reduceRunEvents(this.byRun.get(runId) ?? [], runId);
  }

  async getRun(runId: ID): Promise<Run | undefined> {
    const events = this.byRun.get(runId);
    if (!events?.length) return undefined;
    return reduceRunEvents(events, runId);
  }
}

/** Minimal adapter contract for better-sqlite3, node:sqlite, or another local SQLite binding. */
export interface SqliteDatabase {
  exec(sql: string): void | Promise<void>;
  run(sql: string, params?: readonly unknown[]): void | Promise<void>;
  all<T>(sql: string, params?: readonly unknown[]): T[] | Promise<T[]>;
}

/**
 * SQLite-backed event ledger. The binding is injected so the runtime does not
 * force a native dependency on CLI, Electron, or tests.
 */
export class SqliteEventStore implements EventStore {
  private readonly cache = new Map<ID, DomainEvent[]>();
  private sequence = 0;
  private eventId = 0;
  private initialized = false;

  constructor(private readonly db: SqliteDatabase) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS helm_events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        task_id TEXT,
        session_id TEXT,
        run_id TEXT,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_helm_events_run_sequence ON helm_events(run_id, sequence);
    `);
    const rows = await this.db.all<{ max_sequence: number | null }>('SELECT MAX(sequence) AS max_sequence FROM helm_events');
    this.sequence = Number(rows[0]?.max_sequence ?? 0);
    this.initialized = true;
  }

  async append(input: NewDomainEvent): Promise<DomainEvent> {
    await this.init();
    const event = makeEvent(`evt-${Date.now()}-${++this.eventId}`, ++this.sequence, input, new Date().toISOString());
    await this.db.run(
      `INSERT INTO helm_events (id, sequence, type, task_id, session_id, run_id, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.sequence, event.type, event.taskId ?? null, event.sessionId ?? null, event.runId ?? null, event.timestamp, JSON.stringify(event.payload)],
    );
    if (event.runId) {
      const events = this.cache.get(event.runId) ?? [];
      events.push(event);
      this.cache.set(event.runId, events);
    }
    return event;
  }

  async appendMany(inputs: NewDomainEvent[]): Promise<DomainEvent[]> {
    const result: DomainEvent[] = [];
    for (const input of inputs) result.push(await this.append(input));
    return result;
  }

  async list(runId: ID): Promise<DomainEvent[]> {
    await this.init();
    const rows = await this.db.all<SqliteEventRow>(
      `SELECT id, sequence, type, task_id, session_id, run_id, timestamp, payload_json FROM helm_events WHERE run_id = ? ORDER BY sequence ASC`,
      [runId],
    );
    const events = rows.map(rowToEvent);
    this.cache.set(runId, events);
    return events;
  }

  async listAll(): Promise<DomainEvent[]> {
    await this.init();
    const rows = await this.db.all<SqliteEventRow>(
      `SELECT id, sequence, type, task_id, session_id, run_id, timestamp, payload_json FROM helm_events ORDER BY sequence ASC`,
    );
    return rows.map(rowToEvent);
  }

  replayRun(runId: ID): Run {
    return reduceRunEvents(this.cache.get(runId) ?? [], runId);
  }

  async getRun(runId: ID): Promise<Run | undefined> {
    const events = await this.list(runId);
    return events.length ? reduceRunEvents(events, runId) : undefined;
  }
}

interface SqliteEventRow {
  id: string;
  sequence: number;
  type: DomainEvent['type'];
  task_id: string | null;
  session_id: string | null;
  run_id: string | null;
  timestamp: string;
  payload_json: string;
}

function rowToEvent(row: SqliteEventRow): DomainEvent {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    type: row.type,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}
