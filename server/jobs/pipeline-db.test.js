import test from 'node:test';
import assert from 'node:assert/strict';
import { claimNextJob, updatePipelineJob } from './pipeline-db.js';

test('claims the next job transactionally and maps database fields', async () => {
  const statements = [];
  const client = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.includes('UPDATE pipeline_jobs AS job')) {
        return { rows: [{ id: 'job-1', upload_id: 'upload-1', artist_name: 'DJ TENNIS', venue_slug: 'DJ_Tennis' }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const db = { connect: async () => client };

  const job = await claimNextJob(db, 'worker-1');

  assert.deepEqual(job, {
    jobId: 'job-1',
    uploadId: 'upload-1',
    artistName: 'DJ TENNIS',
    venueSlug: 'DJ_Tennis',
  });
  assert.equal(statements[0].sql, 'BEGIN');
  assert.match(statements[1].sql, /FOR UPDATE SKIP LOCKED/);
  assert.equal(statements[1].values[0], 'worker-1');
  assert.equal(statements[2].sql, 'COMMIT');
});

test('terminal progress clears the job lease and persists counters', async () => {
  let call;
  const db = {
    async query(sql, values) {
      call = { sql, values };
      return { rowCount: 1 };
    },
  };

  await updatePipelineJob(db, 'job-1', 'worker-1', {
    done: 30,
    total: 30,
    status: 'done',
    uploaded: 28,
    failed: 2,
  });

  assert.match(call.sql, /locked_by = CASE WHEN \$9 THEN NULL/);
  assert.deepEqual(call.values, ['job-1', 'worker-1', 30, 30, 'done', 28, 2, null, true]);
});

test('rejects progress updates after the worker loses its lease', async () => {
  const db = { query: async () => ({ rowCount: 0 }) };
  await assert.rejects(
    updatePipelineJob(db, 'job-1', 'worker-1', { done: 0, total: 30, status: 'processing' }),
    /Lost lease/,
  );
});