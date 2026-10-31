/**
 * Unit tests for the `src/utils/math.ts` fixtures: `add` and `subtract`.
 *
 * Four value classes are covered for each function — positive, negative, zero,
 * and floating point — because the fixtures stand in for "real" arithmetic in
 * the e2e scheduling scenarios, and a helper that only works on small positive
 * integers would make those scenarios pass for the wrong reason.
 *
 * Floating point is asserted with `assert.equal` on purpose: `add`/`subtract`
 * perform exactly one IEEE-754 operation each, so the expected value is the
 * same single operation written in the test — `0.1 + 0.2` is bit-for-bit the
 * value the helper returns, and an epsilon comparison would hide a real change
 * to the rounding behaviour.
 *
 * No DSH runtime and no temp directories: the helpers are pure.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, subtract } from '../src/utils/math.ts'

test('add: positive values', () => {
  assert.equal(add(2, 3), 5)
  assert.equal(add(1000, 24), 1024)
  assert.equal(add(0.5, 0.25), 0.75)
})

test('add: negative values', () => {
  assert.equal(add(-2, -3), -5)
  assert.equal(add(-7, 4), -3)
  assert.equal(add(9, -9), 0)
})

test('add: zero', () => {
  assert.equal(add(0, 0), 0)
  assert.equal(add(42, 0), 42)
  assert.equal(add(0, -42), -42)
  // `+ 0` must not flip the sign of a computed zero.
  assert.ok(Object.is(add(-0, -0), -0))
})

test('add: floating point', () => {
  assert.equal(add(0.1, 0.2), 0.1 + 0.2)
  assert.equal(add(1.5, 2.25), 3.75)
  assert.equal(add(1e21, 1), 1e21)
  assert.ok(Number.isNaN(add(Number.NaN, 1)))
  assert.equal(add(Number.POSITIVE_INFINITY, 1), Number.POSITIVE_INFINITY)
})

test('subtract: positive values', () => {
  assert.equal(subtract(5, 3), 2)
  assert.equal(subtract(3, 5), -2)
  assert.equal(subtract(1024, 24), 1000)
})

test('subtract: negative values', () => {
  assert.equal(subtract(-5, -3), -2)
  assert.equal(subtract(-3, 5), -8)
  // Order matters: the second operand is the subtrahend, not a magnitude.
  assert.equal(subtract(3, 1), 2)
})

test('subtract: zero', () => {
  assert.equal(subtract(0, 0), 0)
  assert.equal(subtract(7, 0), 7)
  assert.equal(subtract(0, 7), -7)
})

test('subtract: floating point', () => {
  assert.equal(subtract(0.3, 0.1), 0.3 - 0.1)
  assert.equal(subtract(5.75, 2.5), 3.25)
  assert.equal(subtract(1e21, 1), 1e21)
  assert.ok(Number.isNaN(subtract(Number.NaN, 1)))
  assert.equal(subtract(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), Number.NaN)
})
