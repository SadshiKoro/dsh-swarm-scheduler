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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory under the task pool that holds one JSON file per worker. */
export const INBOX_DIR = 'inbox'

/**
 * The system line appended when a worker holds a task that has spent its whole
 * token budget.
 *
 * It is deliberately an instruction, not a status report: the protocol's only
 * sanctioned way to stop is `swarm_complete` with `success: false`, and a
 * worker that keeps going after reading this has ignored a direct order.
 */
export const BUDGET_LIMIT_EXCEEDED_MESSAGE =
  '[SYSTEM] Budget limit exceeded. Stop working immediately and call swarm_complete with success: false.'

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
  let entries: InboxEntry[] = []
  if (existsSync(path)) {
    const acked = `${path}.${process.pid}${ACK_SUFFIX}`
    try {
      renameSync(path, acked)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return budgetAwareResult(store, workerId, [])
      return { ok: false, entries: [], error: messageOf(error) }
    }
    entries = readEntries(acked)
    try {
      rmSync(acked, { force: true })
    } catch (error) {
      return { ok: false, entries, error: `inbox drained but not removed: ${messageOf(error)}` }
    }
  }
  return budgetAwareResult(store, workerId, entries)
}

/**
 * Task ids held by `workerId` that have already reached their token ceiling.
 *
 * The lookup reads the pool's own task files, so the inbox keeps its structural
 * store contract (`dirPath` only). A malformed or unreadable file is skipped:
 * the budget watch must never be able to break a drain.
 */
export function overBudgetHeldTaskIds(store: InboxStore, workerId: string): string[] {
  let names: string[]
  try {
    names = readdirSync(store.dirPath)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'worker_stats.json') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(store.dirPath, name), 'utf8')) as unknown
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const task = parsed as {
      task_id?: unknown
      status?: unknown
      claimed_by?: unknown
      max_budget_tokens?: unknown
      tokens_used?: unknown
    }
    if (task.claimed_by !== workerId) continue
    if (task.status !== 'claimed' && task.status !== 'running') continue
    const limit = task.max_budget_tokens
    const used = task.tokens_used
    if (typeof limit !== 'number' || typeof used !== 'number') continue
    if (limit <= 0 || used < limit) continue
    if (typeof task.task_id === 'string' && task.task_id.length > 0) out.push(task.task_id)
  }
  return out
}

/**
 * Append the budget warning (when one is owed) and deliver it with this drain.
 *
 * The append happens before the read so the warning cannot be missed by the
 * call that discovered it. It stays queued as well: while the task remains
 * over budget, every read reports it again, which is idempotent by design and
 * is exactly what a worker that has not stopped yet needs to see.
 */
function budgetAwareResult(store: InboxStore, workerId: string, entries: InboxEntry[]): InboxReadResult {
  if (overBudgetHeldTaskIds(store, workerId).length === 0) return { ok: true, entries }
  appendInbox(store, workerId, BUDGET_LIMIT_EXCEEDED_MESSAGE, 'system')
  const path = inboxPathOf(store, workerId)
  if (path === undefined) return { ok: true, entries }
  const queued = readEntries(path).filter(entry => entry.text === BUDGET_LIMIT_EXCEEDED_MESSAGE)
  return { ok: true, entries: queued.length > 0 ? [...entries, queued[0] as InboxEntry] : entries }
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
