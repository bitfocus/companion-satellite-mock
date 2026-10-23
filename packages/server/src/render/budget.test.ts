import { describe, expect, it } from 'vitest'
import { RenderBudget } from './budget.js'

/**
 * The burst capacity, not the refill rate, is what lets a full surface repaint through in one clump.
 *
 * The regression this guards: a 63-key hi-DPI surface is a single ~2.6M-pixel repaint, larger than
 * one second's default budget. Sizing the burst only to the rate drained the bucket mid-paint and the
 * tail keys were sent with no bitmap — permanently blank on a bitmap-only surface. Callers now pass
 * the surface size as the burst.
 */
describe('RenderBudget', () => {
	it('throttles a clump larger than one second when the burst is only the rate', () => {
		const budget = new RenderBudget(1000)
		// 1500 pixels arriving at once cannot fit a 1000-pixel burst.
		expect(budget.tryConsume(30, 50)).toBe(false)
		expect(budget.tryConsume(20, 50)).toBe(true) // 1000 fits exactly
	})

	it('lets a full repaint through when the burst is sized to the surface', () => {
		// Rate stays modest; burst holds the whole 2.6M-pixel surface.
		const budget = new RenderBudget(1000, 2_600_000)
		expect(budget.tryConsume(1600, 1600)).toBe(true) // 2.56M in one clump
	})

	it('never shrinks the burst below the rate', () => {
		// A surface smaller than one second's worth must not lower the burst.
		const budget = new RenderBudget(1000, 10)
		expect(budget.tryConsume(25, 40)).toBe(true) // 1000 still fits
	})

	it('still limits sustained throughput to the refill rate', () => {
		let now = 0
		const budget = new RenderBudget(1000, 5000, () => now)
		expect(budget.tryConsume(50, 100)).toBe(true) // drains the 5000 burst
		expect(budget.tryConsume(1, 1)).toBe(false) // nothing left
		now = 1000 // one second later
		expect(budget.available).toBeCloseTo(1000) // refilled at the rate, not the burst
	})

	it('replenishes at most once per interval, so looping on it cannot bypass the rate', () => {
		let now = 0
		const budget = new RenderBudget(1000, 5000, () => now)
		expect(budget.tryConsume(50, 100)).toBe(true)
		budget.replenish()
		expect(budget.available).toBe(5000) // the first switch gets a full burst

		expect(budget.tryConsume(50, 100)).toBe(true)
		now = 500
		budget.replenish() // too soon: ignored
		expect(budget.available).toBeCloseTo(500)

		now = 2000
		budget.replenish()
		expect(budget.available).toBe(5000)
	})
})
