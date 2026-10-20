/**
 * Unit tests for configuration resolution — specifically the `tasksRoot`
 * fail-fast (v0.2.7).
 *
 * The behaviour under test is a refusal, so the assertions are about the
 * refusal being *useful*: the message names the setting, says what would have
 * happened, and shows the line to add. A throw with a useless message is a
 * worse outcome than no throw at all, because the user is now blocked with no
 * idea what to write next.
 *
 * No DSH runtime and no temp directories: `resolveTasksRoot` is pure apart from
 * `process.cwd()`, which appears in the message and is not asserted verbatim.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTasksRoot } from '../src/config.ts'

test('resolveTasksRoot refuses an empty value', () => {
  assert.throws(() => resolveTasksRoot(''), /tasksRoot is empty/)
})

test('resolveTasksRoot refuses whitespace only', () => {
  for (const value of [' ', '\t', '\n', '  \t\n  ']) {
    assert.throws(() => resolveTasksRoot(value), /tasksRoot is empty/, `should refuse ${JSON.stringify(value)}`)
  }
})

test('the refusal explains the fallback it is refusing and how to fix it', () => {
  const error = (() => {
    try {
      resolveTasksRoot('')
    } catch (caught) {
      return caught as Error
    }
    return undefined
  })()
  assert.ok(error, 'expected a throw')
  const message = error.message
  // What would have happened, and why it is wrong.
  assert.match(message, /process\.cwd\(\)/)
  assert.match(message, /profile directory/)
  // The line to add: a refusal without this is just an obstacle.
  assert.match(message, /tasksRoot: '/)
})

test('resolveTasksRoot returns a configured absolute path unchanged', () => {
  const configured = 'C:/Users/elega/Documents/deepseek-harness/default-workspace'
  assert.equal(resolveTasksRoot(configured), configured)
})

test('resolveTasksRoot trims surrounding whitespace from a configured path', () => {
  assert.equal(resolveTasksRoot('  /srv/workspace  '), '/srv/workspace')
})
