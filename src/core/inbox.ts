/**
 * Per-worker "whisper" inbox: a small mail slot the Lead writes to and a worker
 * drains when it next asks for work.
 *
 * Why a file and not a message: a `send_message` starts a turn. That is the
 * right tool for "come back now", and the wrong one for "when you next pick up
 * work, start from max-4". A whisper written into the pool survives a worker
 * that is busy, idle, or not spawned yet, and it costs the Lead nothing until
 * the worker actually asks for a task.
 *
 * Node built-ins only, like the rest of `src/core/`: the inbox is testable
 * without a DSH runtime, and the store is reached structurally (`dirPath`)
 * rather than through its class, so a fake is enough to drive these functions.
 *
 * Delivery model:
 *   - **append** never reads-then-writes: it re-reads, appends, and replaces the
 *     file, so two whispers in a row are both kept;
 *   - **read is an ack**: the file is `rename`d out of the way first, so a
 *     whisper appended during a drain lands in a *new* file instead of being
 *     deleted by the cleanup. Reading twice therefore returns the second batch.
 *
 * Every function reports a result object instead of throwing. An inbox failure
 * must not be able to fail the claim or the plan that triggered it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory under the task pool that holds one JSON file per worker. */
export const INBOX_DIR = 'inbox'

/** Suffix of the temporary copy a drain reads from (see `readInbox`). */
const ACK_SUFFIX = '.ack'

/**
 * One whisper.
 *
 * `ts` is written by the receiving side at append time, from the local clock —
 * deliberately not taken from a caller-supplied timestamp, so two whispers from
 * two Leads cannot arrive out of order.
 */
export interface InboxEntry {
  ts: string
  from: string
  text: string
}

/**
 * The slice of the task store the inbox needs.
 *
 * Structural on purpose: `TaskStore` satisfies it, and a test can pass
 * `{ dirPath }` without standing up a real store.
 */
export interface InboxStore {
  readonly dirPath: string
}

export interface InboxWriteResult {
  ok: boolean
  /** Absolute path of the worker's inbox file (populated even on some failures). */
  path: string
  /** The entry as written, when `ok`. */
  entry?: InboxEntry
  error?: string
}

export interface InboxReadResult {
  ok: boolean
  entries: InboxEntry[]
  error?: string
}

/**
 * Worker ids allowed as a file name.
 *
 * A worker id is used verbatim in a path, so this is a containment check, not
 * cosmetics: `../lead` must not be able to write outside the inbox directory.
 * The accepted alphabet is what agent ids actually use (`worker-code-2`).
 */
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Whether `workerId` may be used to name an inbox file. */
export function isValidWorkerId(workerId: string): boolean {
  return WORKER_ID_PATTERN.test(workerId) && !workerId.includes('..')
}

/** The inbox directory for this pool (not created by this function). */
export function inboxDirOf(store: InboxStore): string {
  return join(store.dirPath, INBOX_DIR)
}

/**
 * Path of one worker's inbox file, or `undefined` when the id is unusable.
 *
 * Returning `undefined` rather than throwing keeps the caller's failure path the
 * same shape as every other refusal here.
 */
export function inboxPathOf(store: InboxStore, workerId: string): string | undefined {
  if (!isValidWorkerId(workerId)) return undefined
  return join(inboxDirOf(store), `${workerId}.json`)
}

/**
 * Append one whisper to a worker's inbox, creating the directory and file.
 *
 * A malformed existing file is replaced rather than allowed to block delivery:
 * a lost whisper is a lost instruction, while a corrupt array is only an old
 * one. The replacement is written to a temporary path and renamed into place, so
 * a reader never observes a half-written array.
 */
export function appendInbox(
  store: InboxStore,
  workerId: string,
  message: string,
  from: string = 'lead',
): InboxWriteResult {
  const text = message.trim()
  if (text.length === 0) {
    return { ok: false, path: '', error: 'message is empty' }
  }
  const path = inboxPathOf(store, workerId)
  if (path === undefined) {
    return { ok: false, path: '', error: `invalid worker id "${workerId}"` }
  }
  const entry: InboxEntry = { ts: new Date().toISOString(), from: from.trim() || 'lead', text }
  const existing = readEntries(path)
  const entries = [...existing, entry]
  try {
    mkdirSync(inboxDirOf(store), { recursive: true })
    const temporary = `${path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
    return { ok: true, path, entry }
  } catch (error) {
    return { ok: false, path, entry, error: messageOf(error) }
  }
}

/**
 * Drain a worker's inbox: the delivered whispers, and the file is cleared.
 *
 * The rename is the ack. Doing the clear *before* the read is what makes a
 * concurrent {@link appendInbox} safe — it targets the original name, sees no
 * file, and writes a fresh one — while a read-then-delete window would drop
 * anything appended between the two steps.
 *
 * A missing file is an empty inbox (`ok: true`), and a malformed one is consumed
 * as empty: the alternative is a worker that can never drain a corrupt slot.
 */
export function readInbox(store: InboxStore, workerId: string): InboxReadResult {
  const path = inboxPathOf(store, workerId)
  if (path === undefined) {
    return { ok: false, entries: [], error: `invalid worker id "${workerId}"` }
  }
  if (!existsSync(path)) return { ok: true, entries: [] }
  const acked = `${path}.${process.pid}${ACK_SUFFIX}`
  try {
    renameSync(path, acked)
  } catch (error) {
    // ENOENT here means another drain won the race and already took the file.
    if (errorCode(error) === 'ENOENT') return { ok: true, entries: [] }
    return { ok: false, entries: [], error: messageOf(error) }
  }
  const entries = readEntries(acked)
  try {
    rmSync(acked, { force: true })
  } catch (error) {
    // The batch is already in hand; reporting the failed cleanup keeps the
    // caller honest about the file being still on disk (it will be re-read).
    return { ok: false, entries, error: `inbox drained but not removed: ${messageOf(error)}` }
  }
  return { ok: true, entries }
}

/** Count of whispers waiting, without draining them. */
export function inboxSize(store: InboxStore, workerId: string): number {
  const path = inboxPathOf(store, workerId)
  if (path === undefined) return 0
  return readEntries(path).length
}

/**
 * Parse one inbox file into well-formed entries.
 *
 * Tolerant by design: a missing file, a non-array root, and individual malformed
 * records all yield whatever *is* readable. Telemetry-like robustness — a bad
 * file must not break a drain.
 */
function readEntries(path: string): InboxEntry[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: InboxEntry[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { ts?: unknown; from?: unknown; text?: unknown }
    if (typeof record.text !== 'string' || record.text.length === 0) continue
    out.push({
      ts: typeof record.ts === 'string' ? record.ts : '',
      from: typeof record.from === 'string' ? record.from : '',
      text: record.text,
    })
  }
  return out
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
