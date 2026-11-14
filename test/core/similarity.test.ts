/**
 * Task-cache similarity tests (v1.6.0).
 *
 * The contract under test: a completed task is offered as a cache hint only when
 * `0.6 * text Jaccard + 0.4 * capability Jaccard` reaches 0.9, so similar prose
 * with a different capability requirement is not treated as the same work.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blankTask } from '../../src/core/state-machine.ts'
import { CACHE_THRESHOLD, combinedSimilarity, findCachedSolution, jaccard, tokenize } from '../../src/core/similarity.ts'

function solved(taskId: string, title: string, description: string, capabilities: string[], result = 'done'): ReturnType<typeof blankTask> {
  return blankTask(taskId, {
    title,
    description,
    required_capabilities: capabilities,
    status: 'completed',
    result,
    completed_at: '2026-01-01T00:00:00.000Z',
    anchors: [`src/${taskId}.ts:main`],
  })
}

test('identical tasks score 1 and produce a cache hint with result and anchors', () => {
  const title = 'Write a retry helper for HTTP calls'
  const description = 'Implement retryWithBackoff covering timeout and 5xx, with unit tests.'
  const completed = solved('old-retry', title, description, ['code', 'test'])
  const candidate = blankTask('new-retry', { title, description, required_capabilities: ['code', 'test'] })

  const hint = findCachedSolution([completed], candidate)

  assert.equal(hint?.task_id, 'new-retry')
  assert.equal(hint?.cached_task_id, 'old-retry')
  assert.equal(hint?.similarity, 1)
  assert.equal(hint?.result, 'done')
  assert.deepEqual(hint?.anchors, ['src/old-retry.ts:main'])
})

test('the same wording with a different capability contract is not a hit', () => {
  const title = 'Write a retry helper for HTTP calls'
  const description = 'Implement retryWithBackoff covering timeout and 5xx, with unit tests.'
  const completed = solved('old-retry', title, description, ['docs'])
  const candidate = blankTask('new-retry', { title, description, required_capabilities: ['code'] })

  const textOnly = combinedSimilarity(candidate, completed)
  assert.ok(textOnly >= 0.59 && textOnly <= 0.61, `expected ~0.6, got ${textOnly}`)
  assert.equal(findCachedSolution([completed], candidate), undefined)
})

test('unrelated work never produces a hint', () => {
  const completed = solved('old', 'Generate the API client', 'Write typed fetch wrappers for every endpoint.', ['code'])
  const candidate = blankTask('new', { title: 'Add the login page', description: 'Build the email/password form and its tests.', required_capabilities: ['code'] })

  assert.equal(findCachedSolution([completed], candidate), undefined)
})

test('only completed tasks with a result are reusable', () => {
  const title = 'Write the migration'
  const description = 'Create the users table with an index on email.'
  const pending = blankTask('pending-one', {
    title,
    description,
    required_capabilities: ['code', 'sql'],
    status: 'pending',
  })
  const empty = blankTask('completed-empty', {
    title,
    description,
    required_capabilities: ['code', 'sql'],
    status: 'completed',
    result: '',
  })
  const candidate = blankTask('next', { title, description, required_capabilities: ['code', 'sql'] })

  assert.equal(findCachedSolution([pending, empty], candidate), undefined)
})

test('the best of several completed matches wins', () => {
  const title = 'Add the audit table'
  const description = 'Create audit_log rows for every task transition and index them by day.'
  const exact = solved('exact', title, description, ['code', 'sql'], 'exact result')
  const near = solved('near', title, description.replace('day', 'month'), ['code', 'sql'], 'near result')

  const hint = findCachedSolution([near, exact], blankTask('next', {
    title,
    description,
    required_capabilities: ['code', 'sql'],
  }), CACHE_THRESHOLD)

  assert.equal(hint?.cached_task_id, 'exact')
  assert.equal(hint?.result, 'exact result')
})

test('tokenization splits CJK runs and Jaccard stays symmetric', () => {
  assert.deepEqual(tokenize('修复 登录 bug'), ['修', '复', '登', '录', 'bug'])
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3)
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1)
  assert.equal(jaccard([], []), 1)
})
