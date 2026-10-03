import { makeEvent, reduceRunEvents } from './events.js';
import type { DomainEvent, EventStore, ID, NewDomainEvent, Run } from './types.js';

export class InMemoryEventStore implements EventStore {
  private readonly events: DomainEvent[] = [];
  private readonly byRun = new Map<ID, DomainEvent[]>();
  private sequence = 0;
  private eventId = 0;
  private leaseQueue: Promise<void> = Promise.resolve();

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

  async replayRun(runId: ID): Promise<Run> {
    const events = this.byRun.get(runId) ?? [];
    if (!events.length) throw new Error(`No run events found for ${runId}`);
    return reduceRunEvents(events, runId);
  }

  async replayRunAsync(runId: ID): Promise<Run> {
    return this.replayRun(runId);
  }

  async getRun(runId: ID): Promise<Run | undefined> {
    const events = this.byRun.get(runId);
    if (!events?.length) return undefined;
    return reduceRunEvents(events, runId);
  }

  async tryAcquireRunLease(input: { runId: ID; ownerId: ID; leaseExpiresAt: string; now: string }): Promise<DomainEvent | boolean> {
    const operation = this.leaseQueue.then(async () => {
      const run = await this.getRun(input.runId);
      if (!run) return false as const;
      if (run.ownerId && run.ownerId !== input.ownerId && run.leaseExpiresAt && run.leaseExpiresAt > input.now) return false as const;
      return this.append({
        type: 'run.owner_acquired',
        taskId: run.taskId,
        sessionId: run.sessionId,
        runId: run.id,
        payload: { ownerId: input.ownerId, leaseExpiresAt: input.leaseExpiresAt, state: run.state },
      });
    });
    this.leaseQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async exportJsonl(runId?: ID): Promise<string> {
    const events = runId ? await this.list(runId) : await this.listAll();
    return events.map((event) => JSON.stringify(redactExportEvent(event))).join('\n');
  }

  close(): void {
    // In-memory store has no external resource.
  }
}

/** Minimal adapter contract for better-sqlite3, node:sqlite, or another local SQLite binding. */
export interface SqliteDatabase {
  exec(sql: string): void | Promise<void>;
  run(sql: string, params?: readonly unknown[]): void | Promise<void>;
  all<T>(sql: string, params?: readonly unknown[]): T[] | Promise<T[]>;
  transaction<T>(fn: () => T | Promise<T>): T | Promise<T>;
  close?(): void | Promise<void>;
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
  private initialization?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly db: SqliteDatabase) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      if (!this.db.transaction) throw new Error('SQLite adapter must provide transactions.');
      await this.db.exec(`
      CREATE TABLE IF NOT EXISTS helm_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO helm_schema (version, applied_at)
        SELECT 1, '${new Date().toISOString()}' WHERE NOT EXISTS (SELECT 1 FROM helm_schema WHERE version = 1);
      CREATE TABLE IF NOT EXISTS helm_events (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        task_id TEXT,
        session_id TEXT,
        run_id TEXT,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_helm_events_run_sequence ON helm_events(run_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_helm_events_sequence ON helm_events(sequence);
      CREATE TABLE IF NOT EXISTS helm_tasks (
        task_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS helm_sessions (
        session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS helm_runs (
        run_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS helm_checkpoints (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS helm_receipts (
        run_id TEXT NOT NULL,
        step_id TEXT,
        tool_call_id TEXT,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS helm_verifications (
        run_id TEXT NOT NULL,
        step_id TEXT,
        sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      `);
      const schemaRows = await this.db.all<{ version: number }>('SELECT version FROM helm_schema ORDER BY version ASC');
      if (schemaRows.some((row) => Number(row.version) > 1)) throw new Error('Unsupported Helm SQLite schema version.');
      const legacyEvents = await this.db.all<SqliteEventRow>('SELECT id, sequence, type, task_id, session_id, run_id, timestamp, payload_json FROM helm_events ORDER BY sequence ASC');
      // Backfill projections when opening the append-only ledger created by an
      // earlier schema. Projection tables are derived facts, so rebuilding is
      // safe and keeps replay semantics stable across upgrades.
      await this.db.transaction(async () => {
        for (const row of legacyEvents) await this.project(rowToEvent(row));
        await this.db.run("INSERT OR IGNORE INTO helm_schema (version, applied_at) VALUES (1, ?)", [new Date().toISOString()]);
      });
      const rows = await this.db.all<{ max_sequence: number | null }>('SELECT MAX(sequence) AS max_sequence FROM helm_events');
      this.sequence = Number(rows[0]?.max_sequence ?? 0);
      this.initialized = true;
    })();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  async append(input: NewDomainEvent): Promise<DomainEvent> {
    await this.init();
    return this.enqueue(async () => {
      const event = await this.db.transaction(() => this.appendUnsafe(input));
      this.cacheEvent(event);
      return event;
    });
  }

  private async appendUnsafe(input: NewDomainEvent): Promise<DomainEvent> {
    const rows = await this.db.all<{ max_sequence: number | null }>('SELECT MAX(sequence) AS max_sequence FROM helm_events');
    this.sequence = Number(rows[0]?.max_sequence ?? this.sequence);
    const sequence = ++this.sequence;
    const event = makeEvent(`evt-${Date.now()}-${sequence}-${++this.eventId}`, sequence, input, new Date().toISOString());
    await this.db.run(
      `INSERT INTO helm_events (id, sequence, type, task_id, session_id, run_id, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.sequence, event.type, event.taskId ?? null, event.sessionId ?? null, event.runId ?? null, event.timestamp, JSON.stringify(event.payload)],
    );
    await this.project(event);
    return event;
  }

  async appendMany(inputs: NewDomainEvent[]): Promise<DomainEvent[]> {
    await this.init();
    return this.enqueue(async () => {
      const write = async () => {
        const result: DomainEvent[] = [];
        for (const input of inputs) result.push(await this.appendUnsafe(input));
        return result;
      };
      const result = await this.db.transaction(write);
      for (const event of result) this.cacheEvent(event);
      return result;
    });
  }

  private cacheEvent(event: DomainEvent): void {
    if (!event.runId) return;
    const events = this.cache.get(event.runId) ?? [];
    events.push(event);
    this.cache.set(event.runId, events);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async project(event: DomainEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'task.created' && event.taskId) {
      await this.db.run(
        'INSERT INTO helm_tasks (task_id, payload_json, sequence) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET payload_json=excluded.payload_json, sequence=excluded.sequence',
        [event.taskId, JSON.stringify(payload), event.sequence],
      );
    }
    if (event.type === 'session.created' && event.sessionId && event.taskId) {
      await this.db.run(
        'INSERT INTO helm_sessions (session_id, task_id, payload_json, sequence) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET payload_json=excluded.payload_json, sequence=excluded.sequence',
        [event.sessionId, event.taskId, JSON.stringify(payload), event.sequence],
      );
    }
    if (event.runId && ['run.created', 'run.started', 'run.resumed', 'run.state_changed', 'run.paused', 'run.completed', 'run.failed', 'run.cancelled', 'run.needs_reconciliation', 'run.owner_acquired', 'run.owner_released'].includes(event.type)) {
      const state = typeof payload.state === 'string'
        ? payload.state
        : event.type === 'run.completed' ? 'completed'
          : event.type === 'run.failed' ? 'failed'
            : event.type === 'run.cancelled' ? 'cancelled'
              : event.type === 'run.needs_reconciliation' ? 'needs_reconciliation'
                : 'ready';
      const existing = await this.db.all<{ payload_json: string }>('SELECT payload_json FROM helm_runs WHERE run_id = ?', [event.runId]);
      const priorPayload = existing[0]?.payload_json ? JSON.parse(existing[0].payload_json) as Record<string, unknown> : {};
      const runPayload: Record<string, unknown> = { ...priorPayload, ...payload, state };
      if (event.type === 'run.owner_released') {
        // The projection is used for the cross-process lease CAS. Clearing
        // these fields here is required; merging an owner-released payload
        // over the prior row would leave a stale active lease in SQLite even
        // though replay correctly sees the release event.
        delete runPayload.ownerId;
        delete runPayload.leaseExpiresAt;
      }
      await this.db.run(
        'INSERT INTO helm_runs (run_id, state, payload_json, sequence) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state, payload_json=excluded.payload_json, sequence=excluded.sequence',
        [event.runId, state, JSON.stringify(runPayload), event.sequence],
      );
    }
    if (event.type === 'run.checkpoint' && event.runId) {
      await this.db.run(
        'INSERT OR IGNORE INTO helm_checkpoints (run_id, sequence, payload_json) VALUES (?, ?, ?)',
        [event.runId, event.sequence, JSON.stringify(payload)],
      );
    }
    if (event.type === 'tool.receipt' && event.runId) {
      await this.db.run(
        'INSERT OR IGNORE INTO helm_receipts (run_id, step_id, tool_call_id, sequence, payload_json) VALUES (?, ?, ?, ?, ?)',
        [event.runId, typeof payload.stepId === 'string' ? payload.stepId : null, typeof payload.toolCallId === 'string' ? payload.toolCallId : null, event.sequence, JSON.stringify(payload)],
      );
    }
    if (event.type === 'verification.result' && event.runId) {
      await this.db.run(
        'INSERT OR IGNORE INTO helm_verifications (run_id, step_id, sequence, payload_json) VALUES (?, ?, ?, ?)',
        [event.runId, typeof payload.stepId === 'string' ? payload.stepId : null, event.sequence, JSON.stringify(payload)],
      );
    }
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

  async replayRun(runId: ID): Promise<Run> {
    const events = await this.list(runId);
    if (!events.length) throw new Error(`No run events found for ${runId}`);
    return reduceRunEvents(events, runId);
  }

  async replayRunAsync(runId: ID): Promise<Run> {
    const events = await this.list(runId);
    if (!events.length) throw new Error(`No run events found for ${runId}`);
    return reduceRunEvents(events, runId);
  }

  async getRun(runId: ID): Promise<Run | undefined> {
    const events = await this.list(runId);
    return events.length ? reduceRunEvents(events, runId) : undefined;
  }

  async tryAcquireRunLease(input: { runId: ID; ownerId: ID; leaseExpiresAt: string; now: string }): Promise<DomainEvent | boolean> {
    await this.init();
    return this.enqueue(async () => this.db.transaction(async () => {
      const rows = await this.db.all<{ payload_json: string }>('SELECT payload_json FROM helm_runs WHERE run_id = ?', [input.runId]);
      const payload = rows[0]?.payload_json ? JSON.parse(rows[0].payload_json) as Record<string, unknown> : undefined;
      if (!payload) return false;
      const currentOwner = typeof payload.ownerId === 'string' ? payload.ownerId : undefined;
      const currentExpiry = typeof payload.leaseExpiresAt === 'string' ? payload.leaseExpiresAt : undefined;
      if (currentOwner && currentOwner !== input.ownerId && currentExpiry && currentExpiry > input.now) return false;
      const event = await this.appendUnsafe({
        type: 'run.owner_acquired',
        taskId: typeof payload.taskId === 'string' ? payload.taskId : undefined,
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
        runId: input.runId,
        payload: { ownerId: input.ownerId, leaseExpiresAt: input.leaseExpiresAt, state: payload.state ?? 'ready' },
      });
      this.cacheEvent(event);
      return event;
    }));
  }

  async exportJsonl(runId?: ID): Promise<string> {
    const events = runId ? await this.list(runId) : await this.listAll();
    return events.map((event) => JSON.stringify(redactExportEvent(event))).join('\n');
  }

  async close(): Promise<void> {
    try {
      await this.initialization;
      await this.writeQueue;
    } finally {
      await this.db.close?.();
    }
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
  if (!KNOWN_EVENT_TYPES.has(row.type)) throw new Error(`Unsupported Helm event type: ${String(row.type)}`);
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

const KNOWN_EVENT_TYPES = new Set<DomainEvent['type']>([
  'task.created', 'session.created', 'run.created', 'run.started', 'run.state_changed', 'run.paused', 'run.resumed', 'run.completed', 'run.failed', 'run.cancelled', 'run.needs_reconciliation', 'step.started', 'step.proposal', 'policy.decision', 'approval.requested', 'approval.decided', 'tool.call', 'tool.receipt', 'step.observation', 'step.completed', 'verification.result', 'run.checkpoint', 'usage.recorded', 'run.owner_acquired', 'run.owner_released', 'experience.candidate_created', 'experience.candidate_reviewed',
]);

const REDACTED_KEY = /api[-_]?key|authorization|cookie|secret|password|token/i;
const PRIVATE_VALUE_KEY = /^(content|output|body|diff|fileContent|privateFile|oldText|newText)$/i;

function redactExportEvent(event: DomainEvent): DomainEvent {
  return { ...event, payload: redactExportValue(event.payload) as Record<string, unknown> };
}

function redactExportValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactExportValue(item, depth + 1));
  if (typeof value === 'string') return redactExportText(value).slice(0, 2_000);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
    key,
    REDACTED_KEY.test(key) || PRIVATE_VALUE_KEY.test(key) ? '[redacted]' : redactExportValue(item, depth + 1),
  ]));
}

function redactExportText(value: string): string {
  return value
    .replace(/(?:api[-_ ]?key|authorization|cookie|secret|password|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\/(?:Users|private|tmp)\/[^\s]+/g, '[workspace-path]');
}
