/**
 * Minimal arithmetic helpers used by the e2e scheduling fixtures.
 *
 * Depends on **nothing** — no `@deepseek-ai/*` import and no Node built-in — so
 * the two functions can be exercised under `node --test` without any runtime
 * or temp directory. Return types are spelled out rather than inferred, to keep
 * the public surface explicit under `strict` + `noUncheckedIndexedAccess`.
 */

/**
 * Sum two numbers.
 *
 * Intentionally unguarded: `NaN`/`Infinity` propagate exactly as IEEE-754 says
 * they should. Callers that need rejection should validate before calling,
 * because a helper that silently rewrites its inputs is harder to reason about
 * than one that faithfully computes.
 */
export function add(a: number, b: number): number {
  return a + b
}

/**
 * Difference of two numbers: `a - b`.
 *
 * Order matters and is asserted by the tests — `subtract(3, 1)` is `2`, not
 * `-2`. Nothing here clamps or rounds.
 */
export function subtract(a: number, b: number): number {
  return a - b
}
