import { openSqliteEventStore } from '../../src/sqlite-node.js';

const [filename, runId] = process.argv.slice(2);
if (!filename || !runId) throw new Error('filename and run id are required');

const database = openSqliteEventStore(filename);
try {
  const run = await database.store.getRun(runId);
  const events = await database.store.list(runId);
  process.stdout.write(JSON.stringify({
    state: run?.state,
    checkpointRunId: run?.checkpoint?.runId,
    eventCount: events.length,
    jsonlLines: (await database.store.exportJsonl(runId)).trim().split('\n').filter(Boolean).length,
  }));
} finally {
  await database.store.close();
}
