/**
 * Anchor-recall tests.
 *
 * Two layers: the pure matcher over records (the rule itself), and one
 * integration pass over a real temp pool (the wiring to `readAll`). The cases
 * that matter are the ranking (an anchor hit outranks a mere mention), the
 * stability of ties (traversal order is not stable, the answer must be), and the
 * refusals — an empty query must not match the whole pool.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blankTask, type TaskRecord } from '../../src/core/state-machine.ts'
import { recall, recallTasks, RECALL_LIMIT_DEFAULT } from '../../src/core/recall.ts'
import { TaskStore } from '../../src/core/task-store.ts'

function task(id: string, fields: Partial<TaskRecord> = {}): TaskRecord {
  return blankTask(id, fields)
}

test('recallTasks matches title case-insensitively', () => {
  const hits = recallTasks([task('t-1', { title: 'Fix the Workspace merge' })], 'workspace')
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0]?.matchedIn, ['title'])
  assert.equal(hits[0]?.task_id, 't-1')
})

test('recallTasks reports every field that contained the query', () => {
  const hits = recallTasks([
    task('t-1', {
      title: 'Inbox drain',
      description: 'the inbox is drained on claim',
      anchors: ['src/core/inbox.ts:readInbox'],
      result: 'done: inbox empty',
    }),
  ], 'INBOX')
  assert.equal(hits.length, 1)
  // Ranking order, not the order the fields were declared in.
  assert.deepEqual(hits[0]?.matchedIn, ['anchor', 'title', 'description', 'result'])
})

test('recallTasks matches description and result too', () => {
  const byDescription = recallTasks([task('t-1', { description: 'uses git worktree isolation' })], 'worktree')
  assert.deepEqual(byDescription[0]?.matchedIn, ['description'])

  const byResult = recallTasks([task('t-1', { result: 'merged 3 commits; 0 conflicts' })], 'conflicts')
  assert.deepEqual(byResult[0]?.matchedIn, ['result'])
})

test('recallTasks returns the task anchors alongside the match', () => {
  const hits = recallTasks([
    task('t-1', { title: 'Budget circuit breaker', anchors: ['src/core/task-store.ts:claimTask'] }),
  ], 'budget')
  assert.deepEqual(hits[0]?.anchors, ['src/core/task-store.ts:claimTask'])
  assert.deepEqual(hits[0]?.matchedIn, ['title'])
})

test('recallTasks ranks an anchor hit above a title hit, regardless of input order', () => {
  const hits = recallTasks([
    task('t-a', { title: 'touches lib/index.js' }),
    task('t-b', { anchors: ['lib/index.js'] }),
  ], 'lib/index.js')
  assert.deepEqual(hits.map(hit => hit.task_id), ['t-b', 't-a'])
})

test('recallTasks breaks ties by task id, so the answer is stable', () => {
  const hits = recallTasks([
    task('t-c', { title: 'heartbeat lease' }),
    task('t-a', { title: 'heartbeat lease' }),
    task('t-b', { title: 'heartbeat lease' }),
  ], 'heartbeat')
  assert.deepEqual(hits.map(hit => hit.task_id), ['t-a', 't-b', 't-c'])
})

test('recallTasks returns nothing for an unmatched query', () => {
  const hits = recallTasks([task('t-1', { title: 'alpha' })], 'omega')
  assert.deepEqual(hits, [])
})

test('recallTasks treats an empty or whitespace query as no query', () => {
  assert.deepEqual(recallTasks([task('t-1', { title: 'alpha' })], ''), [])
  assert.deepEqual(recallTasks([task('t-1', { title: 'alpha' })], '   '), [])
})

test('recallTasks caps the shortlist and reports the status of each hit', () => {
  const pool = Array.from({ length: RECALL_LIMIT_DEFAULT + 5 }, (_, index) =>
    task(`t-${String(index).padStart(2, '0')}`, { title: 'shared keyword', status: 'completed' }))
  assert.equal(recallTasks(pool, 'shared').length, RECALL_LIMIT_DEFAULT)
  assert.equal(recallTasks(pool, 'shared', 3).length, 3)
  assert.equal(recallTasks(pool, 'shared', 0).length, pool.length)
  assert.equal(recallTasks(pool, 'shared', 3)[0]?.status, 'completed')
})

test('recall searches a real pool through the store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recall-'))
  const store = new TaskStore(undefined, root)
  try {
    for (const record of [
      task('max-1', { title: 'core fields', anchors: ['src/core/state-machine.ts'], status: 'completed' }),
      task('max-2', { title: 'worktree isolation', description: 'safe merge back' }),
      task('max-3', { title: 'task store', result: 'budget breaker implemented' }),
    ]) {
      const created = await store.createExclusive(record)
      assert.equal(created.ok, true, created.error)
    }

    const anchored = await recall(store, 'STATE-MACHINE')
    assert.deepEqual(anchored.map(hit => hit.task_id), ['max-1'])
    assert.deepEqual(anchored[0]?.matchedIn, ['anchor'])

    const mentioned = await recall(store, 'budget')
    assert.deepEqual(mentioned.map(hit => hit.task_id), ['max-3'])
    assert.deepEqual(mentioned[0]?.matchedIn, ['result'])

    assert.deepEqual(await recall(store, 'nothing-like-this'), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
