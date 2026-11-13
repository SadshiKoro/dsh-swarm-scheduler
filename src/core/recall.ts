/**
 * Anchor recall: find the tasks in the pool whose recorded knowledge mentions a
 * query.
 *
 * Anchors are the durable half of a handoff. A result says what happened; an
 * anchor says *how to find it again* — a file, a symbol, a decision id. Recall
 * is therefore searched across the four fields that outlive a turn (`anchors`,
 * `title`, `description`, `result`) and reports which one hit, so the caller can
 * tell "a task is literally about this" from "a step of it happened to mention
 * it".
 *
 * Matching is case-insensitive substring — no tokenizer, no fuzzy distance. An
 * approximate match is a guess, and a guess is the one thing a recall call must
 * not return: a worker acting on a wrong anchor wastes a whole turn.
 *
 * Node built-ins only; the store is reached structurally (`readAll`), so the
 * matching rule is testable as a pure function over records.
 */

import type { TaskRecord, TaskStatus } from './state-machine.ts'

/** The four searchable fields, in ranking order. */
export type RecallField = 'anchor' | 'title' | 'description' | 'result'

/** Field order doubles as match-quality order: an anchor hit outranks a mention. */
export const RECALL_FIELD_ORDER: readonly RecallField[] = ['anchor', 'title', 'description', 'result']

/** One task that matched, with the fields responsible. */
export interface RecallHit {
  task_id: string
  title: string
  status: TaskStatus
  /** All anchors declared by the task (not only the matching ones). */
  anchors: string[]
  /** Non-empty by construction: which of the searched fields contained the query. */
  matchedIn: RecallField[]
}

/**
 * The slice of the task store recall needs.
 *
 * Structural so this module does not import the store class — `TaskStore`
 * satisfies it, and a two-line fake is enough in a test.
 */
export interface RecallStore {
  readAll(): Promise<{ tasks: TaskRecord[] }>
}

/** Default cap on returned hits; a recall answer is a shortlist, not a dump. */
export const RECALL_LIMIT_DEFAULT = 20

/**
 * Match `query` against a list of records.
 *
 * Pure and synchronous, so the rule can be tested without a filesystem and the
 * adapter can reuse it over records it already holds.
 *
 * @param limit - maximum hits; a non-positive or non-finite value means "no
 *   cap". Hits are ordered by match quality, then by task id: two tasks that
 *   both name the query in their title must come back in a stable order even
 *   though directory traversal order is not stable.
 */
export function recallTasks(
  tasks: readonly TaskRecord[],
  query: string,
  limit: number = RECALL_LIMIT_DEFAULT,
): RecallHit[] {
  const needle = normalize(query)
  if (needle.length === 0) return []
  const hits: RecallHit[] = []
  for (const task of tasks) {
    const matchedIn = fieldsMatching(task, needle)
    if (matchedIn.length === 0) continue
    hits.push({
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      anchors: [...task.anchors],
      matchedIn,
    })
  }
  hits.sort((left, right) => {
    const rank = RECALL_FIELD_ORDER.indexOf(left.matchedIn[0] ?? 'result')
      - RECALL_FIELD_ORDER.indexOf(right.matchedIn[0] ?? 'result')
    if (rank !== 0) return rank
    return left.task_id < right.task_id ? -1 : left.task_id > right.task_id ? 1 : 0
  })
  const budget = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  return budget > 0 ? hits.slice(0, budget) : hits
}

/**
 * Search the whole pool.
 *
 * A pool read that fails is reported as "nothing matched": recall is advisory,
 * so an unreadable pool must not fail the tool call that asked. Callers that
 * need the read error visible should call `store.readAll()` themselves and use
 * {@link recallTasks}.
 */
export async function recall(
  store: RecallStore,
  query: string,
  limit: number = RECALL_LIMIT_DEFAULT,
): Promise<RecallHit[]> {
  const { tasks } = await store.readAll()
  return recallTasks(tasks, query, limit)
}

/** Every field of one task that contains the already-normalized needle. */
function fieldsMatching(task: TaskRecord, needle: string): RecallField[] {
  const matched: RecallField[] = []
  if (task.anchors.some(anchor => normalize(anchor).includes(needle))) matched.push('anchor')
  if (normalize(task.title).includes(needle)) matched.push('title')
  if (normalize(task.description).includes(needle)) matched.push('description')
  if (normalize(task.result).includes(needle)) matched.push('result')
  return matched
}

function normalize(value: string): string {
  return value.toLowerCase()
}
