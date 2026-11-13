/**
 * Git-worktree isolation for a single task, and the safe merge back.
 *
 * Node built-ins only — like the rest of `src/core/`, this module must be
 * usable (and testable) without a DSH runtime. It shells out to the `git`
 * binary through `spawnSync`; every function reports a result object instead of
 * throwing, because the scheduler treats a failed workspace operation as a
 * routing decision, not as a crash.
 *
 * Lifecycle of one isolated attempt:
 *
 *   createWorkspace() ──▶ work in the linked worktree ──▶ mergeWorkspace()
 *                                                    └─▶ removeWorkspace()
 *
 * The main worktree is never checked out to the temporary branch: the commit
 * happens in the linked worktree, and only `git merge --no-ff` runs in the
 * main checkout. A conflict therefore aborts in the main worktree and leaves
 * its HEAD exactly where it was — the "never break the main tree" guarantee.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** Outcome of creating an isolated worktree. */
export interface WorkspaceResult {
  ok: boolean
  /** Absolute path of the linked worktree (meaningful when `ok`). */
  path: string
  /** Human-readable detail: git output, or the reason it failed. */
  message: string
}

/** Outcome of merging a workspace back into the main worktree. */
export interface MergeResult {
  ok: boolean
  /** True only when the merge stopped on a real content conflict. */
  conflict: boolean
  message: string
}

/** Outcome of removing a linked worktree. */
export interface RemoveResult {
  ok: boolean
  message: string
}

interface GitRun {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Identity for the commits this module creates.
 *
 * Passed as `-c` flags on every commit/merge so the scheduler does not depend
 * on the host machine having a usable `user.name` configured, and never
 * triggers an interactive signing prompt.
 */
const IDENTITY = [
  '-c', 'user.name=dsh-swarm-scheduler',
  '-c', 'user.email=dsh-swarm-scheduler@localhost',
  '-c', 'commit.gpgsign=false',
]

function git(cwd: string, args: string[]): GitRun {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) {
    return { ok: false, stdout: '', stderr: result.error.message }
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  }
}

function detail(run: GitRun, fallback: string): string {
  return run.stderr || run.stdout || fallback
}

/**
 * Branch names cannot contain arbitrary text (and a task id comes from a file,
 * so it is untrusted). Keep it predictable and legal.
 */
function safeBranchPart(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 40) : 'task'
}

/**
 * The main worktree of the repository that owns `workspacePath`.
 *
 * `git worktree list --porcelain` always lists the main worktree first; the
 * linked checkout we are inside cannot answer that question about itself.
 */
function mainWorktreePath(workspacePath: string): string | undefined {
  const run = git(workspacePath, ['worktree', 'list', '--porcelain'])
  if (!run.ok) return undefined
  const line = run.stdout.split(/\r?\n/).find(entry => entry.startsWith('worktree '))
  return line === undefined ? undefined : line.slice('worktree '.length).trim()
}

/**
 * Create a detached worktree for `taskId` under `<tasksDir>/workspaces/<taskId>`.
 *
 * `tasksDir` may be absolute or relative to `repoRoot`; the returned `path` is
 * always absolute so the record stores something a later process can reuse.
 */
export function createWorkspace(repoRoot: string, tasksDir: string, taskId: string): WorkspaceResult {
  const base = isAbsolute(tasksDir) ? tasksDir : resolve(repoRoot, tasksDir)
  const path = join(base, 'workspaces', taskId)
  if (existsSync(path)) {
    return { ok: false, path, message: `workspace already exists: ${path}` }
  }
  mkdirSync(dirname(path), { recursive: true })
  const run = git(repoRoot, ['worktree', 'add', '--detach', path, 'HEAD'])
  if (!run.ok) {
    return { ok: false, path, message: detail(run, 'git worktree add failed') }
  }
  return { ok: true, path, message: detail(run, 'workspace created') }
}

/**
 * Commit the workspace's changes and merge them into the main worktree.
 *
 * Steps:
 *   1. `git add -A` plus a commit on a temporary branch in the worktree;
 *   2. `git merge --no-ff <branch>` in the **main** worktree;
 *   3. on conflict: `git merge --abort` in the main worktree and report
 *      `{ ok: false, conflict: true }` — the main HEAD is left untouched.
 *
 * An empty workspace is not an error: there is simply nothing to merge, so the
 * result is `ok: true` with `conflict: false`.
 */
export function mergeWorkspace(workspacePath: string): MergeResult {
  if (!existsSync(workspacePath)) {
    return { ok: false, conflict: false, message: `workspace not found: ${workspacePath}` }
  }
  const main = mainWorktreePath(workspacePath)
  if (main === undefined) {
    return { ok: false, conflict: false, message: 'could not resolve the main worktree' }
  }

  const add = git(workspacePath, ['add', '-A'])
  if (!add.ok) {
    return { ok: false, conflict: false, message: detail(add, 'git add failed') }
  }
  const status = git(workspacePath, ['status', '--porcelain'])
  if (!status.ok) {
    return { ok: false, conflict: false, message: detail(status, 'git status failed') }
  }
  if (status.stdout.length === 0) {
    return { ok: true, conflict: false, message: 'no changes to merge' }
  }

  const branch = `swarm-merge-${safeBranchPart(workspacePath.split(/[\\/]/).pop() ?? 'task')}`
    + `-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const checkout = git(workspacePath, ['checkout', '-B', branch, 'HEAD'])
  if (!checkout.ok) {
    return { ok: false, conflict: false, message: detail(checkout, 'git checkout failed') }
  }
  const commit = git(workspacePath, [...IDENTITY, 'commit', '-m', `swarm: isolated changes (${branch})`])
  if (!commit.ok) {
    cleanupBranch(workspacePath, main, branch)
    return { ok: false, conflict: false, message: detail(commit, 'git commit failed') }
  }

  const merge = git(main, [...IDENTITY, 'merge', '--no-ff', branch, '-m', `swarm: merge ${branch}`])
  if (merge.ok) {
    cleanupBranch(workspacePath, main, branch)
    return { ok: true, conflict: false, message: 'merged' }
  }

  const mergeHead = git(main, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  if (mergeHead.ok) {
    git(main, ['merge', '--abort'])
    cleanupBranch(workspacePath, main, branch)
    return { ok: false, conflict: true, message: detail(merge, 'merge conflict') }
  }

  cleanupBranch(workspacePath, main, branch)
  return { ok: false, conflict: false, message: detail(merge, 'git merge failed') }
}

/** Leave the worktree detached and drop the temporary branch (best effort). */
function cleanupBranch(workspacePath: string, main: string, branch: string): void {
  git(workspacePath, ['checkout', '--detach', 'HEAD'])
  git(main, ['branch', '-D', branch])
}

/**
 * Force-remove a linked worktree.
 *
 * `git worktree remove` runs from the main worktree, not from inside the
 * checkout being deleted. An already-absent directory is treated as success so
 * cleanup after a crash is idempotent.
 */
export function removeWorkspace(workspacePath: string): RemoveResult {
  if (!existsSync(workspacePath)) {
    return { ok: true, message: 'workspace already removed' }
  }
  const main = mainWorktreePath(workspacePath)
  if (main === undefined) {
    return { ok: false, message: 'could not resolve the main worktree' }
  }
  const run = git(main, ['worktree', 'remove', '--force', workspacePath])
  if (!run.ok) {
    return { ok: false, message: detail(run, 'git worktree remove failed') }
  }
  return { ok: true, message: 'workspace removed' }
}
