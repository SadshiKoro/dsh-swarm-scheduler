/**
 * Worktree isolation tests.
 *
 * Every test builds a throwaway git repository (and a throwaway tasks
 * directory) so nothing here depends on this project's own checkout. The
 * conflict test is the important one: a failed merge must leave the main
 * worktree's HEAD and status exactly as they were.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspace,
  mergeWorkspace,
  removeWorkspace,
} from '../../src/core/workspace.ts'

const IDENTITY = [
  '-c', 'user.name=workspace-test',
  '-c', 'user.email=workspace-test@localhost',
  '-c', 'commit.gpgsign=false',
]

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
  return (result.stdout ?? '').trim()
}

interface TempRepo {
  root: string
  tasks: string
}

/** A committed repo plus a separate tasks dir; both live under the OS temp dir. */
function makeRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ws-repo-'))
  const tasks = mkdtempSync(join(tmpdir(), 'dsh-ws-tasks-'))
  git(root, ['init', '-q'])
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  writeFileSync(join(root, 'file.txt'), 'base\n')
  git(root, ['add', '-A'])
  git(root, [...IDENTITY, 'commit', '-q', '-m', 'init'])
  return { root, tasks }
}

function cleanup(repo: TempRepo, workspace?: string): void {
  if (workspace !== undefined) removeWorkspace(workspace)
  rmSync(repo.root, { recursive: true, force: true })
  rmSync(repo.tasks, { recursive: true, force: true })
}

/** Read a file with line endings normalized; git may check out CRLF on Windows. */
function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

test('createWorkspace checks out a detached linked worktree under tasksDir', () => {
  const repo = makeRepo()
  const created = createWorkspace(repo.root, repo.tasks, 'task-1')
  try {
    assert.equal(created.ok, true, created.message)
    assert.equal(created.path, join(repo.tasks, 'workspaces', 'task-1'))
    assert.equal(existsSync(created.path), true)
    // A linked worktree reports the checkout, not a submodule.
    assert.equal(git(created.path, ['rev-parse', '--is-inside-work-tree']), 'true')
    // Detached HEAD: no branch is checked out.
    assert.equal(git(created.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD')
    assert.equal(readText(join(created.path, 'file.txt')), 'base\n')
  } finally {
    cleanup(repo, created.path)
  }
})

test('createWorkspace refuses a path that already exists', () => {
  const repo = makeRepo()
  const first = createWorkspace(repo.root, repo.tasks, 'dup')
  try {
    assert.equal(first.ok, true, first.message)
    const second = createWorkspace(repo.root, repo.tasks, 'dup')
    assert.equal(second.ok, false)
    assert.match(second.message, /already exists/)
  } finally {
    cleanup(repo, first.path)
  }
})

test('mergeWorkspace brings isolated edits back into the main worktree', () => {
  const repo = makeRepo()
  const created = createWorkspace(repo.root, repo.tasks, 'merge-ok')
  assert.equal(created.ok, true, created.message)
  try {
    writeFileSync(join(created.path, 'file.txt'), 'isolated change\n')
    writeFileSync(join(created.path, 'added.txt'), 'new file\n')

    const merged = mergeWorkspace(created.path)
    assert.equal(merged.ok, true, merged.message)
    assert.equal(merged.conflict, false)

    assert.equal(readText(join(repo.root, 'file.txt')), 'isolated change\n')
    assert.equal(readText(join(repo.root, 'added.txt')), 'new file\n')
    // A --no-ff merge commit on top of the original history.
    assert.match(git(repo.root, ['log', '-1', '--pretty=%s']), /merge/i)
    assert.equal(git(repo.root, ['status', '--porcelain']), '')
    // The temporary branch does not linger.
    assert.equal(git(repo.root, ['branch', '--list', 'swarm-merge-*']), '')
  } finally {
    cleanup(repo, created.path)
  }
})

test('mergeWorkspace on an unchanged workspace is a clean no-op', () => {
  const repo = makeRepo()
  const created = createWorkspace(repo.root, repo.tasks, 'merge-empty')
  assert.equal(created.ok, true, created.message)
  try {
    const headBefore = git(repo.root, ['rev-parse', 'HEAD'])
    const merged = mergeWorkspace(created.path)
    assert.equal(merged.ok, true)
    assert.equal(merged.conflict, false)
    assert.equal(git(repo.root, ['rev-parse', 'HEAD']), headBefore)
  } finally {
    cleanup(repo, created.path)
  }
})

test('mergeWorkspace reports a conflict and leaves the main HEAD untouched', () => {
  const repo = makeRepo()
  const created = createWorkspace(repo.root, repo.tasks, 'merge-conflict')
  assert.equal(created.ok, true, created.message)
  try {
    // Both sides change the same line.
    writeFileSync(join(created.path, 'file.txt'), 'from workspace\n')
    writeFileSync(join(repo.root, 'file.txt'), 'from main\n')
    git(repo.root, ['add', 'file.txt'])
    git(repo.root, [...IDENTITY, 'commit', '-q', '-m', 'main diverges'])
    const headBefore = git(repo.root, ['rev-parse', 'HEAD'])

    const merged = mergeWorkspace(created.path)
    assert.equal(merged.ok, false)
    assert.equal(merged.conflict, true, merged.message)

    // Aborted merge: same HEAD, no merge state, no dirty files.
    assert.equal(git(repo.root, ['rev-parse', 'HEAD']), headBefore)
    assert.equal(git(repo.root, ['status', '--porcelain']), '')
    const mergeHead = spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], {
      cwd: repo.root, encoding: 'utf8', windowsHide: true,
    })
    assert.notEqual(mergeHead.status, 0)
    assert.equal(readText(join(repo.root, 'file.txt')), 'from main\n')
    // The temporary branch was cleaned up even on the conflict path.
    assert.equal(git(repo.root, ['branch', '--list', 'swarm-merge-*']), '')
  } finally {
    cleanup(repo, created.path)
  }
})

test('removeWorkspace deletes the linked checkout and is idempotent', () => {
  const repo = makeRepo()
  const created = createWorkspace(repo.root, repo.tasks, 'remove-me')
  assert.equal(created.ok, true, created.message)
  try {
    const removed = removeWorkspace(created.path)
    assert.equal(removed.ok, true, removed.message)
    assert.equal(existsSync(created.path), false)
    assert.equal(git(repo.root, ['worktree', 'list', '--porcelain']).includes(created.path), false)
    // Second call: nothing left to remove, still a success.
    assert.equal(removeWorkspace(created.path).ok, true)
  } finally {
    cleanup(repo)
  }
})
