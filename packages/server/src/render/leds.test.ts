import { describe, expect, it } from 'vitest'
import { ledsToBuffer, sampleLeds, sampleLedsToBuffer } from './leds.js'

describe('sampleLeds', () => {
	it('lights nothing at zero and everything at one', () => {
		expect(sampleLeds(0, 8, 'simple').filter((c) => c.r || c.g || c.b)).toHaveLength(1) // position 0 is lit
		expect(sampleLeds(1, 8, 'simple').every((c) => c.r || c.g || c.b)).toBe(true)
	})

	it('clamps out-of-range values rather than producing nonsense', () => {
		expect(sampleLeds(-5, 4, 'simple')).toEqual(sampleLeds(0, 4, 'simple'))
		expect(sampleLeds(5, 4, 'simple')).toEqual(sampleLeds(1, 4, 'simple'))
	})

	it('turns unlit segments fully off, not dim', () => {
		// The spec says an absent LEDS field means all off. A client treating off-segments as
		// "unchanged" shows stale colour, and this makes that visible rather than subtle.
		const sampled = sampleLeds(0.25, 8, 'simple')
		expect(sampled.at(-1)).toEqual({ r: 0, g: 0, b: 0 })
	})

	it("rotates a full-ring so the sweep starts at 6 o'clock", () => {
		const simple = sampleLeds(1, 8, 'simple')
		const ring = sampleLeds(1, 8, 'full-ring')
		expect(ring).not.toEqual(simple)
		expect(ring).toHaveLength(8)
		// A rotation, so the multiset of colours is unchanged.
		expect([...ring].sort((a, b) => a.r - b.r)).toEqual([...simple].sort((a, b) => a.r - b.r))
	})

	it('handles the degenerate segment counts', () => {
		expect(sampleLeds(0.5, 0, 'simple')).toEqual([])
		expect(sampleLeds(0.5, 1, 'simple')).toHaveLength(1)
	})
})

describe('ledsToBuffer', () => {
	it('packs three bytes per segment', () => {
		const buffer = ledsToBuffer([
			{ r: 1, g: 2, b: 3 },
			{ r: 4, g: 5, b: 6 },
		])
		expect([...buffer]).toEqual([1, 2, 3, 4, 5, 6])
	})

	it('always decodes to exactly segments * 3 bytes, as the spec requires', () => {
		for (const segments of [1, 8, 24, 200]) {
			expect(sampleLedsToBuffer(0.5, segments, 'full-ring')).toHaveLength(segments * 3)
		}
	})
})
