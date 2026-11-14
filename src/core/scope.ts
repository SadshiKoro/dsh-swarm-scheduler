/**
 * Write-scope arithmetic: normalization, overlap, and conflict lookup.
 *
 * Depends on **Node built-ins only** — no `@deepseek-ai/*` import. Kept separate
 * from the task store because these rules are pure and are the ones most worth
 * testing in isolation.
 */
import { statSync } from 'node:fs'
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
 * Whether one write scope names a directory.
 *
 * Two markers count: a trailing separator (`src/`, `src\\`), and a path that
 * currently exists as a directory. Anything else is treated as a file. The
 * distinction is what keeps a directory scope from swallowing the files inside
 * it: `src/` and `src/api.ts` are allowed to coexist, while `src/` and
 * `src/utils/` still serialise.
 */
function isDirectoryScope(raw: string): boolean {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (trimmed.length === 0) return false
  if (trimmed.endsWith('/')) return true
  try {
    return statSync(trimmed).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether two scopes overlap, meaning one task's edit can land in the other's.
 *
 * Three cases, each decided by what the two scopes *are*:
 *
 *   - **file ↔ file**: only the identical normalized path conflicts. Two
 *     different files never do, no matter how close their names are.
 *   - **directory ↔ directory**: the same directory, or one is an ancestor of
 *     the other, conflicts (`src/` vs `src/utils/`). The comparison is
 *     segment-aware, so `src/` never matches `src2/`.
 *   - **directory ↔ file** (either direction): allowed. The file task owns one
 *     file; the directory task may in principle touch it, but a claim-time
 *     refusal here would serialise every task under a directory against every
 *     file scope, which is the blanket rule v1.5.1 removes.
 *
 * Normalization keeps `src\\api` and `src/api/` the same scope, as before.
 */
export function scopesOverlap(a: string, b: string): boolean {
  const left = normalizeScope(a)
  const right = normalizeScope(b)
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  if (!isDirectoryScope(a) || !isDirectoryScope(b)) return false
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
