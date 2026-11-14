/**
 * Inline-comment red line tests (v1.5.0).
 *
 * Every case builds a throwaway git repository: the audit is defined in terms of
 * a diff against HEAD, so a repository is part of the input, not an accident.
 * The assertions pin the four contract cases: one comment passes, two fail,
 * JSDoc is exempt, and an untracked file is counted in full.
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditInlineComments } from '../../src/core/comment-audit.ts'

const IDENTITY = [
  '-c', 'user.name=comment-audit-test',
  '-c', 'user.email=comment-audit-test@localhost',
  '-c', 'commit.gpgsign=false',
]

const repos: string[] = []

afterEach(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true })
  repos.length = 0
})

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-comment-audit-'))
  repos.push(root)
  git(root, ['init', '-q'])
  git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  writeFileSync(join(root, 'source.ts'), 'export const base = 1\n')
  git(root, ['add', '-A'])
  git(root, [...IDENTITY, 'commit', '-q', '-m', 'init'])
  return root
}

test('one added inline comment is below the default threshold', () => {
  const root = makeRepo()
  writeFileSync(
    join(root, 'source.ts'),
    'export const base = 1\nexport const url = "https://example.invalid" // see the spec\n',
  )

  const result = auditInlineComments({ repoRoot: root, scopes: ['source.ts'] })

  assert.equal(result.count, 1)
  assert.equal(result.ok, true)
  assert.deepEqual(result.files, ['source.ts'])
})

test('two added inline comments fail the audit', () => {
  const root = makeRepo()
  writeFileSync(
    join(root, 'source.ts'),
    'export const base = 1\n// first explanation\n// second explanation\n',
  )

  const result = auditInlineComments({ repoRoot: root, scopes: ['source.ts'] })

  assert.equal(result.count, 2)
  assert.equal(result.ok, false)
  assert.deepEqual(result.files, ['source.ts'])
})

test('JSDoc and block-comment lines are exempt', () => {
  const root = makeRepo()
  writeFileSync(
    join(root, 'source.ts'),
    'export const base = 1\n'
      + '/**\n'
      + ' * Documents the exported function signature.\n'
      + ' */\n'
      + 'export function documented(): number {\n'
      + '  return 1\n'
      + '}\n',
  )

  const result = auditInlineComments({ repoRoot: root, scopes: ['source.ts'] })

  assert.equal(result.count, 0)
  assert.equal(result.ok, true)
  assert.deepEqual(result.files, [])
})

test('an untracked file is counted in full', () => {
  const root = makeRepo()
  writeFileSync(join(root, 'added.ts'), '// first\nexport const value = 1\n// second\n')

  const result = auditInlineComments({ repoRoot: root, scopes: ['added.ts'] })

  assert.equal(result.count, 2)
  assert.equal(result.ok, false)
  assert.deepEqual(result.files, ['added.ts'])
})

test('a directory scope recurses over source files only', () => {
  const root = makeRepo()
  mkdirSync(join(root, 'pkg'))
  writeFileSync(join(root, 'pkg', 'code.ts'), '// one\n// two\nexport const x = 1\n')
  writeFileSync(join(root, 'pkg', 'notes.md'), '// not source\n// still not source\n')

  const result = auditInlineComments({ repoRoot: root, scopes: ['pkg'] })

  assert.equal(result.count, 2)
  assert.equal(result.ok, false)
  assert.deepEqual(result.files, ['pkg/code.ts'])
})

test('an explicit threshold moves the line', () => {
  const root = makeRepo()
  writeFileSync(join(root, 'source.ts'), 'export const base = 1\n// only one\n')

  assert.equal(auditInlineComments({ repoRoot: root, scopes: ['source.ts'], threshold: 2 }).ok, true)
  assert.equal(auditInlineComments({ repoRoot: root, scopes: ['source.ts'], threshold: 1 }).ok, false)
})
