/**
 * Task-result cache: detect a planned task that a completed task already solved.
 *
 * The cache is **advisory**. `swarm_plan` reports a hint with the earlier task's
 * result and anchors so the Lead can choose to reuse it or plan only the delta;
 * nothing here ever reuses a result on its own. That keeps the safety model
 * intact: a cached result is evidence for a human decision, not a substitute
 * for the task record.
 *
 * Scoring (v1.6.0, fixed by the contract):
 *   text  = Jaccard(title + description tokens)
 *   caps  = Jaccard(required_capabilities)
 *   score = 0.6 * text + 0.4 * caps
 *
 * A hit requires `score >= threshold` (default 0.9), so a task must match both
 * its wording *and* its capability contract; similar prose with a different
 * skill requirement is not the same work.
 */

import type { TaskRecord } from './state-machine.ts'

/** Minimum combined similarity for a completed task to be offered as a cache hit. */
export const CACHE_THRESHOLD = 0.9

/** The fields the similarity contract is computed from. */
export interface SimilarityInput {
  task_id?: string
  title: string
  description: string
  required_capabilities: string[]
}

/** One advisory reuse hint returned by `swarm_plan`. */
export interface CacheHint {
  task_id: string
  cached_task_id: string
  /** Combined similarity in `[0, 1]`, rounded to four decimals. */
  similarity: number
  /** The completed task's compressed result, carried verbatim for reuse. */
  result: string
  /** The completed task's durable anchors, so the Lead can locate the evidence. */
  anchors: string[]
}

/**
 * Split text into comparable tokens.
 *
 * Latin words stay whole; CJK runs are split into characters, because those
 * languages do not use spaces and a whole sentence would otherwise be one token
 * that matches nothing.
 */
export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const out: string[] = []
  for (const word of words) {
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (const character of word) out.push(character)
    } else {
      out.push(word)
    }
  }
  return out
}

/** Jaccard set similarity; two empty sets are identical (`1`). */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size === 0 && right.size === 0) return 1
  let intersection = 0
  for (const item of left) {
    if (right.has(item)) intersection += 1
  }
  const union = left.size + right.size - intersection
  return union === 0 ? 1 : intersection / union
}

function textSimilarity(a: SimilarityInput, b: SimilarityInput): number {
  return jaccard(
    tokenize(`${a.title} ${a.description}`),
    tokenize(`${b.title} ${b.description}`),
  )
}

function capabilitySimilarity(a: SimilarityInput, b: SimilarityInput): number {
  return jaccard(
    a.required_capabilities.map(capability => capability.trim().toLowerCase()).filter(Boolean),
    b.required_capabilities.map(capability => capability.trim().toLowerCase()).filter(Boolean),
  )
}

/** The weighted score used by the cache lookup. */
export function combinedSimilarity(a: SimilarityInput, b: SimilarityInput): number {
  return 0.6 * textSimilarity(a, b) + 0.4 * capabilitySimilarity(a, b)
}

function asInput(value: TaskRecord | SimilarityInput): SimilarityInput {
  return {
    title: value.title,
    description: value.description,
    required_capabilities: value.required_capabilities,
  }
}

/**
 * The best completed task that already solved `candidate`, or `undefined`.
 *
 * Only `completed` tasks carrying a non-empty `result` are candidates: a
 * pending or failed task has nothing to reuse, and an empty result would make
 * the hint a pointer to silence.
 */
export function findCachedSolution(
  completedTasks: readonly TaskRecord[],
  candidate: TaskRecord | SimilarityInput,
  threshold: number = CACHE_THRESHOLD,
): CacheHint | undefined {
  const input = asInput(candidate)
  const candidateId = 'task_id' in candidate && typeof candidate.task_id === 'string' ? candidate.task_id : ''
  let best: { task: TaskRecord; score: number } | undefined
  for (const task of completedTasks) {
    if (task.status !== 'completed') continue
    if (task.result.length === 0) continue
    if (task.task_id === candidateId) continue
    const score = combinedSimilarity(input, asInput(task))
    if (score < threshold) continue
    if (best === undefined || score > best.score) best = { task, score }
  }
  if (best === undefined) return undefined
  return {
    task_id: candidateId,
    cached_task_id: best.task.task_id,
    similarity: Math.round(best.score * 10_000) / 10_000,
    result: best.task.result,
    anchors: [...best.task.anchors],
  }
}
