/**
 * Write-scope arithmetic: normalization, overlap, and conflict lookup.
 *
 * Depends on **Node built-ins only** — no `@deepseek-ai/*` import. Kept separate
 * from the task store because these rules are pure and are the ones most worth
 * testing in isolation.
 */
import type { TaskRecord } from './state-machine.ts'

/**
 * Normalize one write scope for comparison.
 *
 * Mirrors the kernel's rule (`writeScope()` in the agent-team package): forward
 * slashes, no leading `./`, no trailing slash, no empty segments. Keeping the
 * same normalization matters — the two are compared against each other, and
 * `src/api` vs `./src/api/` is the same scope written two ways.
 */
export function normalizeScope(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim()
}

/**
 * Whether two scopes overlap, meaning a single-file write could land in both.
 *
 * Equal scopes overlap, and so do ancestor/descendant pairs: a task owning
 * `src` and a task owning `src/api` can edit the same file. The comparison is
 * therefore **directory-granular, not file-granular** — two tasks that both
 * declare `src/` are refused even when they would touch different files in it.
 * That is the intended trade: a false refusal costs one serialisation step,
 * while a false admission costs a silently overwritten file.
 */
export function scopesOverlap(a: string, b: string): boolean {
  const left = normalizeScope(a)
  const right = normalizeScope(b)
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Find the first claimed task whose write scopes collide with `task`'s.
 *
 * Returns the conflicting task and the exact scope pair, so the refusal can name
 * both — "scope_conflict" alone would leave the caller guessing which of its
 * scopes is the problem.
 */
export function findScopeConflict(
  task: TaskRecord,
  others: readonly TaskRecord[],
): { task_id: string; claimed_by: string; scope: string; other_scope: string } | undefined {
  if (task.write_scopes.length === 0) return undefined
  for (const other of others) {
    if (other.task_id === task.task_id) continue
    if (other.status !== 'claimed' && other.status !== 'running') continue
    for (const mine of task.write_scopes) {
      for (const theirs of other.write_scopes) {
        if (scopesOverlap(mine, theirs)) {
          return { task_id: other.task_id, claimed_by: other.claimed_by, scope: mine, other_scope: theirs }
        }
      }
    }
  }
  return undefined
}

/** True when at least one scope is directory-level (trailing slash). */
export function hasDirectoryScope(scopes: readonly string[]): boolean {
  return scopes.some(scope => normalizeScope(scope) !== scope.trim().replace(/\\/g, '/').replace(/^\.\//, '') || scope.trim().endsWith('/'))
}
