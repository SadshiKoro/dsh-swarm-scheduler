/**
 * Inline-comment red line (v1.5.0).
 *
 * A comment cannot be executed, so nothing checks whether it is still true. The
 * pool's contract is that a task's *design intent* travels in `anchors` (where
 * `swarm_recall` can find it) and in the task record — never smuggled into the
 * source as prose that silently rots.
 *
 * This module audits **only the lines a worker added**: the diff against HEAD in
 * the workspace being validated, or the full text of an untracked file. Existing
 * comments in a repository are not the worker's doing and are never blamed on it.
 *
 * Node built-ins only, like the rest of `src/core/`: the function reports a
 * result object and never throws.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Outcome of one audit pass. */
export interface CommentAuditResult {
  /** True when the added inline-comment count is below the threshold. */
  ok: boolean
  /** How many added lines are inline comments. */
  count: number
  /** Files that contributed at least one offending line, root-relative. */
  files: string[]
}

/** One task's audit input. */
export interface CommentAuditInput {
  /** Repository root the pool lives in (used when `workspace` is empty). */
  repoRoot: string
  /** Isolated worktree to audit; empty means "audit `repoRoot`". */
  workspace?: string
  /** Repository-relative file or directory paths the task may modify. */
  scopes: string[]
  /** Fail at `count >= threshold`; defaults to {@link INLINE_COMMENT_THRESHOLD}. */
  threshold?: number
}

/** Two added comment lines are already a design document living in code. */
export const INLINE_COMMENT_THRESHOLD = 2

/** Only source files are audited; assets and data files have no comments. */
const AUDITABLE_EXTENSION = /\.(ts|tsx|js|mjs)$/

/**
 * JSDoc / block-comment lines are allowed: they are the one place a *signature*
 * is documented. The pattern is deliberately narrow and matches the contract.
 */
const JSDOC_LINE = /^\s*(\/\*\*|\*|\*\/)/

/**
 * True when one line is a **new inline comment**.
 *
 * - a line that starts with `//` counts (it explains the line that follows);
 * - a trailing ` // ` counts (it explains the line it is attached to);
 * - a `://` protocol marker inside a string is text, not commentary;
 * - JSDoc/block-comment lines are exempt.
 */
export function isInlineCommentLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  if (JSDOC_LINE.test(line)) return false
  if (trimmed.startsWith('//')) return true
  const marker = trimmed.indexOf(' // ')
  if (marker < 0) return false
  // Exclude `://` (the carve-out in the contract): a trailing marker directly
  // after a scheme colon belongs to a URL, not to the worker's explanation.
  return !trimmed.slice(0, marker).endsWith(':')
}

function countAddedLines(diff: string): number {
  let count = 0
  for (const raw of diff.split(/\r?\n/)) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue
    if (isInlineCommentLine(raw.slice(1))) count += 1
  }
  return count
}

function countFullText(text: string): number {
  let count = 0
  for (const raw of text.split(/\r?\n/)) {
    if (isInlineCommentLine(raw)) count += 1
  }
  return count
}

/** Every auditable file under one scope (file scope or recursive directory scope). */
function filesInScope(root: string, scope: string): string[] {
  const absolute = isAbsolute(scope) ? resolve(scope) : resolve(root, scope)
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    return []
  }
  if (stats.isFile()) return [absolute]
  if (!stats.isDirectory()) return []

  const out: string[] = []
  const stack: string[] = [absolute]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        stack.push(child)
      } else if (entry.isFile() && AUDITABLE_EXTENSION.test(entry.name)) {
        out.push(child)
      }
    }
  }
  return out
}

function runGit(root: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: result.stdout ?? '',
  }
}

/**
 * Count the added inline comments one file contributes.
 *
 * Tracked files are diffed against `HEAD`, so untouched comments are invisible.
 * Untracked files (and any tree git cannot diff) are counted in full — a file
 * the worker just created has no history to subtract.
 */
function countFile(root: string, absolute: string): number {
  const rel = relative(root, absolute).split(sep).join('/')
  const tracked = runGit(root, ['ls-files', '--error-unmatch', '--', rel]).ok
  if (!tracked) {
    try {
      return countFullText(readFileSync(absolute, 'utf8'))
    } catch {
      return 0
    }
  }
  const diff = runGit(root, ['diff', '--unified=0', 'HEAD', '--', rel])
  if (!diff.ok) {
    try {
      return countFullText(readFileSync(absolute, 'utf8'))
    } catch {
      return 0
    }
  }
  return countAddedLines(diff.stdout)
}

/**
 * Audit the added inline comments in `scopes`.
 *
 * The isolated `workspace` (a linked worktree) wins over `repoRoot` when set:
 * that is where the task's work actually lives. Nothing here throws; an
 * unreadable scope contributes zero, which is the only safe reading for a gate
 * that must not fail because of its own bookkeeping.
 */
export function auditInlineComments(input: CommentAuditInput): CommentAuditResult {
  const threshold = typeof input.threshold === 'number'
    && Number.isFinite(input.threshold) && input.threshold > 0
    ? input.threshold
    : INLINE_COMMENT_THRESHOLD
  const workspace = input.workspace !== undefined && input.workspace.length > 0
    ? input.workspace
    : undefined
  const root = workspace ?? input.repoRoot

  let count = 0
  const files: string[] = []
  const seen = new Set<string>()
  for (const scope of input.scopes) {
    for (const absolute of filesInScope(root, scope)) {
      const rel = relative(root, absolute).split(sep).join('/')
      if (seen.has(rel)) continue
      seen.add(rel)
      const added = countFile(root, absolute)
      if (added > 0) {
        count += added
        files.push(rel)
      }
    }
  }
  return { ok: count < threshold, count, files }
}
