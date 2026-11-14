/**
 * Scope-overlap unit tests for the v1.5.1 three-case rule.
 *
 * The rule is deliberately decided by what a scope *is*: directories still
 * serialise against directories, files only collide with the same file, and a
 * directory no longer swallows every file scope beneath it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blankTask } from '../../src/core/state-machine.ts'
import { findScopeConflict, normalizeScope, scopesOverlap } from '../../src/core/scope.ts'

test('directory scopes conflict on the same or an ancestor directory, segment-aware', () => {
  assert.equal(scopesOverlap('src/', 'src/'), true)
  assert.equal(scopesOverlap('src/', 'src/utils/'), true)
  assert.equal(scopesOverlap('src/utils/', 'src/'), true)
  assert.equal(scopesOverlap('src/utils/deep/', 'src/'), true)
  assert.equal(scopesOverlap('src/', 'src2/'), false)
  assert.equal(scopesOverlap('src/api/', 'src2/api/'), false)
  assert.equal(scopesOverlap('src/', 'docs/'), false)
})

test('file scopes conflict only on the identical normalized path', () => {
  assert.equal(scopesOverlap('src/a.ts', 'src/a.ts'), true)
  assert.equal(scopesOverlap('src/a.ts', 'src/b.ts'), false)
  assert.equal(scopesOverlap('src/a.ts', 'src/a.ts.bak'), false)
  assert.equal(scopesOverlap('./src/a.ts', 'src\\a.ts'), true)
  assert.equal(scopesOverlap('src\\api', './src/api/'), true)
})

test('a directory scope and a file scope are allowed together', () => {
  assert.equal(scopesOverlap('src/', 'src/a.ts'), false)
  assert.equal(scopesOverlap('src/a.ts', 'src/'), false)
  assert.equal(scopesOverlap('src/utils/', 'src/api.ts'), false)
})

test('a path that exists as a directory is classified as one', () => {
  assert.equal(scopesOverlap('src', 'src/core'), true)
  assert.equal(scopesOverlap('src', 'src/core/task-store.ts'), false)
})

test('normalization keeps slash and dot variants of one scope equal', () => {
  assert.equal(normalizeScope('./src/api/'), 'src/api')
  assert.equal(scopesOverlap('src/api', './src/api/'), true)
})

test('findScopeConflict admits a file held inside another task directory scope', () => {
  const directoryTask = blankTask('dir-task', {
    status: 'claimed',
    claimed_by: 'worker-a',
    write_scopes: ['src/'],
  })
  const fileTask = blankTask('file-task', { write_scopes: ['src/a.ts'] })

  assert.equal(findScopeConflict(fileTask, [directoryTask]), undefined)

  const nestedDirectory = blankTask('nested-dir-task', { write_scopes: ['src/utils/'] })
  const conflict = findScopeConflict(nestedDirectory, [directoryTask])
  assert.equal(conflict?.task_id, 'dir-task')
  assert.equal(conflict?.scope, 'src/utils/')
  assert.equal(conflict?.other_scope, 'src/')
})
