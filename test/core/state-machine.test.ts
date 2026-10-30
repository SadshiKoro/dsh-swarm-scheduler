/**
 * Core state-machine tests: the six-state derivations and the ready-pool cap.
 *
 * No DSH import: this file exercises `src/core/state-machine.ts` alone, which is
 * the point of the core split.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blankTask,
  computeReady,
  viewOf,
  viewsOf,
  type TaskRecord,
} from '../../src/core/state-machine.ts'

function byId(tasks: TaskRecord[]): Map<string, TaskRecord> {
  return new Map(tasks.map(task => [task.task_id, task]))
}

test('viewOf marks only pending-with-completed-blockers as ready', () => {
  const blocker = blankTask('a', { status: 'pending' })
  const task = blankTask('b', { blocked_by: ['a'] })
  const map = byId([blocker, task])
  assert.equal(viewOf(task, map).ready, false)

  blocker.status = 'completed'
  assert.equal(viewOf(task, byId([blocker, task])).ready, true)
})

test('viewOf derives running and heartbeat ages for a running task', () => {
  const now = Date.now()
  const task = blankTask('r', {
    status: 'running',
    claimed_at: new Date(now - 30_000).toISOString(),
    started_at: new Date(now - 20_000).toISOString(),
    heartbeat_at: new Date(now - 5_000).toISOString(),
  })
  const view = viewOf(task, byId([task]), now, 600)
  assert.equal(view.status, 'running')
  assert.equal(view.claimed_age_sec, 30)
  assert.equal(view.running_age_sec, 20)
  assert.equal(view.heartbeat_age_sec, 5)
  assert.equal(view.stale, false)
})

test('viewOf marks a running task stale past the threshold', () => {
  const now = Date.now()
  const task = blankTask('r', {
    status: 'running',
    claimed_at: new Date(now - 20 * 60_000).toISOString(),
    started_at: new Date(now - 20 * 60_000).toISOString(),
    heartbeat_at: new Date(now - 20 * 60_000).toISOString(),
  })
  const view = viewOf(task, byId([task]), now, 600)
  assert.equal(view.stale, true)
})

test('viewOf keeps failed/blocked task retry metadata', () => {
  const task = blankTask('f', { status: 'failed', retry_count: 2, max_retries: 3, failure_reason: 'boom' })
  const view = viewsOf([task])[0] as ReturnType<typeof viewOf>
  assert.equal(view.status, 'failed')
  assert.equal(view.retry_count, 2)
  assert.equal(view.failure_reason, 'boom')
  assert.equal(view.ready, false)
})

test('computeReady returns ready tasks below the worker ceiling', () => {
  const tasks = [blankTask('a'), blankTask('b'), blankTask('c', { status: 'claimed', claimed_by: 'w1' })]
  const result = computeReady(tasks, 3)
  assert.equal(result.limited, false)
  assert.deepEqual(result.tasks.map(task => task.task_id).sort(), ['a', 'b'])
})

test('computeReady returns zero and limited when claimed+running reaches max_workers', () => {
  const tasks = [
    blankTask('a', { status: 'claimed', claimed_by: 'w1' }),
    blankTask('b', { status: 'running', claimed_by: 'w2' }),
    blankTask('c'),
  ]
  const result = computeReady(tasks, 2)
  assert.equal(result.limited, true)
  assert.equal(result.total, 0)
  assert.equal(result.tasks.length, 0)
  // The reason must be produced by the core, not improvised by the adapter:
  // v0.3.0 shipped a second source that shadowed it.
  assert.equal(result.notice, 'max_workers limit (2) reached')
})

test('computeReady carries no notice below the ceiling', () => {
  const result = computeReady([blankTask('a')], 3)
  assert.equal(result.limited, false)
  assert.equal(result.notice, undefined)
})

test('computeReady still returns ready tasks when ceiling is disabled (0)', () => {
  const tasks = [blankTask('a'), blankTask('b', { status: 'running' })]
  const result = computeReady(tasks, 0)
  assert.equal(result.limited, false)
  assert.equal(result.total, 1)
})

test('computeReady honours the big_task_id filter', () => {
  const tasks = [blankTask('a', { big_task_id: 'T1' }), blankTask('b', { big_task_id: 'T2' })]
  const result = computeReady(tasks, 3, 'T2')
  assert.deepEqual(result.tasks.map(task => task.task_id), ['b'])
})
