import { describe, expect, it } from 'vitest'
import { DEFAULT_BUTTON_STYLE } from './buttonStyle.js'
import { TEST_PATTERNS, type TestPattern } from './patterns.js'
import { ButtonRenderer } from './renderer.js'

const renderer = new ButtonRenderer()
const SIZE = 72

function pixels(pattern: TestPattern, size = SIZE): (x: number, y: number) => [number, number, number] {
	const rgb = renderer.renderRgb({ ...DEFAULT_BUTTON_STYLE, pattern }, size, size)
	return (x, y) => {
		const i = (y * size + x) * 3
		return [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!]
	}
}

/** BT.601 luma, as a YUV encoder would compute it. */
const luma = ([r, g, b]: [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b

/**
 * What a 4:2:2 encoder does to one row: keep each pixel's luma, average chroma over column pairs.
 * Returns the chroma (Cb, Cr) each pixel ends up with.
 */
function subsample422(row: [number, number, number][]): [number, number][] {
	const chroma = row.map((p): [number, number] => {
		const y = luma(p)
		return [p[2] - y, p[0] - y]
	})
	return chroma.map((_, x) => {
		const pair = x - (x % 2)
		const a = chroma[pair]!
		const b = chroma[pair + 1] ?? a
		return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
	})
}

describe('test patterns', () => {
	it('draws every pattern without throwing, at odd sizes and rotated', () => {
		for (const pattern of TEST_PATTERNS) {
			for (const size of [1, 7, 72, 120]) {
				expect(() => renderer.renderRgb({ ...DEFAULT_BUTTON_STYLE, pattern }, size, size)).not.toThrow()
			}
			expect(() => renderer.renderRgb({ ...DEFAULT_BUTTON_STYLE, pattern }, 72, 72, 90)).not.toThrow()
		}
	})

	it('draws one-pixel stripes exactly, with no anti-aliasing between them', () => {
		const at = pixels('chroma-stripes')
		for (let x = 0; x < SIZE; x++) {
			expect(at(x, SIZE / 2)).toEqual(x % 2 === 0 ? [255, 0, 0] : [0, 0, 255])
		}
	})

	it('makes the isoluminant stripes pure colour detail, which 4:2:2 erases completely', () => {
		const at = pixels('isoluminant')
		const row = Array.from({ length: SIZE }, (_, x) => at(x, 10))

		// No brightness detail to survive: neighbouring columns have the same luma to within a level.
		for (let x = 1; x < SIZE; x++) expect(Math.abs(luma(row[x]!) - luma(row[x - 1]!))).toBeLessThan(2)

		// And after averaging chroma over column pairs, every pair is the same colour: the stripes
		// are gone. This is the property that makes the pattern a test.
		const chroma = subsample422(row)
		expect(new Set(chroma.map(([cb, cr]) => `${cb.toFixed(1)},${cr.toFixed(1)}`)).size).toBe(1)
	})

	it('keeps the black and white control pattern intact under 4:2:2', () => {
		// The control: all of its detail is in luma, so subsampling chroma changes nothing. Stripes
		// that survive here but not in the colour patterns mean subsampling, not blur or scaling.
		const at = pixels('luma-stripes')
		const lumas = Array.from({ length: SIZE }, (_, x) => luma(at(x, 10)))
		for (let x = 0; x < SIZE; x++) expect(lumas[x]).toBeCloseTo(x % 2 === 0 ? 255 : 0, 0)
	})

	it('puts a distinct colour in each corner, so a flipped image is obvious', () => {
		const at = pixels('markers')
		expect(at(4, 4)).toEqual([255, 0, 0])
		expect(at(SIZE - 5, 4)).toEqual([0, 255, 0])
		expect(at(4, SIZE - 5)).toEqual([0, 0, 255])
		expect(at(SIZE - 5, SIZE - 5)).toEqual([255, 255, 0])
		expect(at(0, SIZE / 2)).toEqual([255, 255, 255]) // the one-pixel frame
	})

	it('steps through the levels a video-range conversion would crush', () => {
		const at = pixels('levels')
		const darks = new Set(Array.from({ length: 6 }, (_, i) => at(Math.round((i + 0.5) * (SIZE / 6)), 5)[0]))
		expect([...darks]).toEqual([0, 8, 16, 24, 32, 48])
	})

	it('caches patterned and plain buttons separately', () => {
		const plain = renderer.render(DEFAULT_BUTTON_STYLE, { width: 8, height: 8, format: 'rgb' })
		const patterned = renderer.render(
			{ ...DEFAULT_BUTTON_STYLE, pattern: 'luma-stripes' },
			{ width: 8, height: 8, format: 'rgb' }
		)
		expect(patterned).not.toBe(plain)
	})
})
