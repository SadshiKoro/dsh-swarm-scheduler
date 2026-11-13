/**
 * Whisper-inbox tests.
 *
 * Every case runs against a throwaway pool root under the OS temp directory, so
 * nothing here touches this project's own `.dsh-tasks`. The two behaviours worth
 * protecting are the ack (a drain must clear the file exactly once) and
 * containment (a worker id is a file name, so `../x` must be refused, not
 * sanitised into a different file).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendInbox,
  inboxDirOf,
  inboxPathOf,
  inboxSize,
  isValidWorkerId,
  readInbox,
} from '../../src/core/inbox.ts'
import { TaskStore } from '../../src/core/task-store.ts'

/** A real store over a temp workspace; `dirPath` is `<root>/.dsh-tasks`. */
function makeStore(): { store: TaskStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inbox-'))
  return { store: new TaskStore(undefined, root), root }
}

test('appendInbox creates the directory and one entry with ts/from/text', () => {
  const { store, root } = makeStore()
  try {
    const written = appendInbox(store, 'worker-code', 'take max-3 next', 'lead')
    assert.equal(written.ok, true, written.error)
    assert.equal(written.path, join(inboxDirOf(store), 'worker-code.json'))
    assert.equal(existsSync(written.path), true)

    const onDisk = JSON.parse(readFileSync(written.path, 'utf8')) as Array<Record<string, unknown>>
    assert.equal(onDisk.length, 1)
    assert.equal(onDisk[0]?.from, 'lead')
    assert.equal(onDisk[0]?.text, 'take max-3 next')
    assert.equal(typeof onDisk[0]?.ts, 'string')
    // Real ISO timestamp, not an empty placeholder.
    assert.equal(Number.isNaN(Date.parse(String(onDisk[0]?.ts))), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('appendInbox keeps earlier whispers, in append order', () => {
  const { store, root } = makeStore()
  try {
    appendInbox(store, 'worker-a', 'first', 'lead')
    appendInbox(store, 'worker-a', 'second', 'worker-b')
    assert.equal(inboxSize(store, 'worker-a'), 2)

    const drained = readInbox(store, 'worker-a')
    assert.deepEqual(drained.entries.map(entry => entry.text), ['first', 'second'])
    assert.deepEqual(drained.entries.map(entry => entry.from), ['lead', 'worker-b'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readInbox is an ack: the second drain is empty and the file is gone', () => {
  const { store, root } = makeStore()
  try {
    const path = inboxPathOf(store, 'worker-a') as string
    appendInbox(store, 'worker-a', 'only once', 'lead')

    const first = readInbox(store, 'worker-a')
    assert.equal(first.ok, true, first.error)
    assert.deepEqual(first.entries.map(entry => entry.text), ['only once'])
    assert.equal(existsSync(path), false)

    const second = readInbox(store, 'worker-a')
    assert.equal(second.ok, true)
    assert.deepEqual(second.entries, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readInbox on a worker that was never whispered to is an empty success', () => {
  const { store, root } = makeStore()
  try {
    const drained = readInbox(store, 'nobody')
    assert.equal(drained.ok, true)
    assert.deepEqual(drained.entries, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a malformed inbox is consumed as empty rather than wedging the worker', () => {
  const { store, root } = makeStore()
  try {
    const path = inboxPathOf(store, 'worker-a') as string
    mkdirSync(inboxDirOf(store), { recursive: true })
    writeFileSync(path, 'not json at all\n', 'utf8')

    const drained = readInbox(store, 'worker-a')
    assert.equal(drained.ok, true, drained.error)
    assert.deepEqual(drained.entries, [])
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('individual malformed records are skipped, well-formed ones survive', () => {
  const { store, root } = makeStore()
  try {
    const path = inboxPathOf(store, 'worker-a') as string
    mkdirSync(inboxDirOf(store), { recursive: true })
    writeFileSync(path, JSON.stringify([
      { ts: '2026-01-01T00:00:00.000Z', from: 'lead', text: 'keep me' },
      42,
      null,
      { from: 'lead', text: '' },
      { ts: '', from: 'worker-b', text: 'and me' },
    ]), 'utf8')

    const drained = readInbox(store, 'worker-a')
    assert.deepEqual(drained.entries.map(entry => entry.text), ['keep me', 'and me'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('appendInbox replaces a corrupt file instead of losing the new whisper', () => {
  const { store, root } = makeStore()
  try {
    const path = inboxPathOf(store, 'worker-a') as string
    mkdirSync(inboxDirOf(store), { recursive: true })
    writeFileSync(path, '[] trailing garbage', 'utf8')

    const written = appendInbox(store, 'worker-a', 'fresh instruction', 'lead')
    assert.equal(written.ok, true, written.error)
    assert.deepEqual(readInbox(store, 'worker-a').entries.map(entry => entry.text), ['fresh instruction'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('worker ids that could escape the inbox directory are refused', () => {
  const { store, root } = makeStore()
  try {
    for (const bad of ['', '../escape', 'a/b', 'a\\b', '.', '..', '-lead']) {
      assert.equal(isValidWorkerId(bad), false, `expected ${JSON.stringify(bad)} to be rejected`)
      assert.equal(inboxPathOf(store, bad), undefined)
      const written = appendInbox(store, bad, 'should not land', 'lead')
      assert.equal(written.ok, false)
      assert.equal(written.path, '')
    }
    // Nothing was created anywhere near the pool root.
    assert.equal(existsSync(join(store.dirPath, 'escape.json')), false)
    assert.equal(existsSync(join(root, 'escape.json')), false)
    assert.deepEqual(readInbox(store, '../escape').entries, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty whisper is refused: only a real instruction is stored', () => {
  const { store, root } = makeStore()
  try {
    const written = appendInbox(store, 'worker-a', '   ', 'lead')
    assert.equal(written.ok, false)
    assert.match(String(written.error), /empty/)
    assert.equal(inboxSize(store, 'worker-a'), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a whisper appended during a drain survives it', () => {
  const { store, root } = makeStore()
  try {
    appendInbox(store, 'worker-a', 'old', 'lead')
    // The interleaving the ack design exists for: the drain renames the file out
    // of the way first, so a whisper appended meanwhile targets the original
    // name again and is not swallowed by the cleanup.
    readInbox(store, 'worker-a')
    appendInbox(store, 'worker-a', 'arrived during the drain', 'lead')

    // No temporary copy was left behind in the inbox directory.
    assert.deepEqual(readdirSync(inboxDirOf(store)), ['worker-a.json'])

    assert.deepEqual(readInbox(store, 'worker-a').entries.map(entry => entry.text), ['arrived during the drain'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
