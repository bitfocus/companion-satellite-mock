import { describe, expect, it } from 'vitest'
import {
	buildSurface,
	controlAt,
	convertIndexToXY,
	convertXYToIndex,
	layoutFromLegacyParams,
	parseKeyParam,
	type GridSize,
} from './surface.js'
import { parseLineParameters } from './parse.js'

const legacy = (line: string) => layoutFromLegacyParams(parseLineParameters(line))

describe('layoutFromLegacyParams', () => {
	it('defaults to a 32-key 8-wide grid, matching Companion', () => {
		const layout = legacy('DEVICEID=x PRODUCT_NAME=y')
		expect(typeof layout).not.toBe('string')
		if (typeof layout === 'string') return
		expect(Object.keys(layout.controls)).toHaveLength(32)
		expect(layout.controls['0/0']).toEqual({ row: 0, column: 0 })
		expect(layout.controls['3/7']).toEqual({ row: 3, column: 7 })
	})

	it('names controls row/column, so legacy and advanced share one id scheme', () => {
		const layout = legacy('KEYS_TOTAL=6 KEYS_PER_ROW=3')
		if (typeof layout === 'string') throw new Error(layout)
		expect(Object.keys(layout.controls)).toEqual(['0/0', '0/1', '0/2', '1/0', '1/1', '1/2'])
	})

	it('rejects a grid outside upstream bounds', () => {
		expect(legacy('KEYS_TOTAL=0')).toBe('Invalid KEYS_TOTAL')
		expect(legacy('KEYS_TOTAL=2001')).toBe('Invalid KEYS_TOTAL')
		expect(legacy('KEYS_TOTAL=abc')).toBe('Invalid KEYS_TOTAL')
		expect(legacy('KEYS_PER_ROW=0')).toBe('Invalid KEYS_PER_ROW')
		expect(legacy('KEYS_PER_ROW=1001')).toBe('Invalid KEYS_PER_ROW')
	})

	it('accepts the documented bounds exactly', () => {
		expect(typeof legacy('KEYS_TOTAL=2000 KEYS_PER_ROW=1000')).not.toBe('string')
		expect(typeof legacy('KEYS_TOTAL=1 KEYS_PER_ROW=1')).not.toBe('string')
	})

	it('quirk 11: treats BITMAPS=1 and small numbers as the legacy 72px', () => {
		const size = (line: string) => {
			const layout = legacy(line)
			if (typeof layout === 'string') throw new Error(layout)
			return layout.stylePresets.default.bitmap
		}
		expect(size('BITMAPS=1')).toEqual({ w: 72, h: 72 })
		expect(size('BITMAPS=true')).toEqual({ w: 72, h: 72 })
		expect(size('BITMAPS=4')).toEqual({ w: 72, h: 72 })
		expect(size('BITMAPS=5')).toEqual({ w: 5, h: 5 })
		expect(size('BITMAPS=96')).toEqual({ w: 96, h: 96 })
	})

	it('omits bitmaps entirely when falsey or absent', () => {
		for (const line of ['BITMAPS=0', 'BITMAPS=false', '']) {
			const layout = legacy(line)
			if (typeof layout === 'string') throw new Error(layout)
			expect(layout.stylePresets.default.bitmap, line).toBeUndefined()
		}
	})

	it('maps COLORS onto the format choice', () => {
		const colors = (line: string) => {
			const layout = legacy(line)
			if (typeof layout === 'string') throw new Error(layout)
			return layout.stylePresets.default.colors
		}
		expect(colors('COLORS=true')).toBe('hex')
		expect(colors('COLORS=hex')).toBe('hex')
		expect(colors('COLORS=rgb')).toBe('rgb')
		expect(colors('COLORS=false')).toBeUndefined()
		expect(colors('')).toBeUndefined()
	})
})

describe('buildSurface', () => {
	it('derives the grid from the furthest control', () => {
		const surface = buildSurface(
			{
				stylePresets: { default: {} },
				controls: { a: { row: 0, column: 0 }, b: { row: 2, column: 4 } },
			},
			true
		)
		expect(surface.gridSize).toEqual({ rows: 3, columns: 5 })
	})

	it('applies a named style preset, falling back to default', () => {
		const surface = buildSurface(
			{
				stylePresets: { default: { colors: 'hex' }, encoder: { colors: 'rgb' } },
				controls: {
					plain: { row: 0, column: 0 },
					enc: { row: 0, column: 1, stylePreset: 'encoder' },
					missing: { row: 0, column: 2, stylePreset: 'nope' },
				},
			},
			true
		)
		expect(surface.controls.get('plain')!.style.colors).toBe('hex')
		expect(surface.controls.get('enc')!.style.colors).toBe('rgb')
		// An unknown preset name falls back rather than failing the registration.
		expect(surface.controls.get('missing')!.style.colors).toBe('hex')
	})

	it('produces an empty grid for an empty control map', () => {
		const surface = buildSurface({ stylePresets: { default: {} }, controls: {} }, true)
		expect(surface.gridSize).toEqual({ rows: 0, columns: 0 })
	})
})

describe('index/xy conversion', () => {
	const grid: GridSize = { rows: 4, columns: 8 }

	it('round trips', () => {
		for (let i = 0; i < 32; i++) {
			const xy = convertIndexToXY(i, grid)!
			expect(convertXYToIndex(xy[0], xy[1], grid)).toBe(i)
		}
	})

	it('rejects out-of-range values', () => {
		expect(convertIndexToXY(32, grid)).toBeNull()
		expect(convertIndexToXY(-1, grid)).toBeNull()
		expect(convertXYToIndex(8, 0, grid)).toBeNull()
		expect(convertXYToIndex(0, 4, grid)).toBeNull()
	})
})

describe('parseKeyParam', () => {
	const grid: GridSize = { rows: 4, columns: 8 }

	it('accepts a flat index', () => {
		expect(parseKeyParam('0', grid)).toEqual([0, 0])
		expect(parseKeyParam('9', grid)).toEqual([1, 1])
		expect(parseKeyParam('31', grid)).toEqual([7, 3])
	})

	it('accepts row/column, returning [x, y] — the opposite order to the wire', () => {
		expect(parseKeyParam('0/0', grid)).toEqual([0, 0])
		expect(parseKeyParam('1/1', grid)).toEqual([1, 1])
		expect(parseKeyParam('3/7', grid)).toEqual([7, 3])
	})

	it("tolerates a leading + on either part, as upstream's regex does", () => {
		expect(parseKeyParam('+1/+1', grid)).toEqual([1, 1])
		expect(parseKeyParam('+1/1', grid)).toEqual([1, 1])
	})

	it('rejects out-of-range and malformed keys', () => {
		expect(parseKeyParam('32', grid)).toBeNull()
		expect(parseKeyParam('-1', grid)).toBeNull()
		expect(parseKeyParam('4/0', grid)).toBeNull()
		expect(parseKeyParam('0/8', grid)).toBeNull()
		expect(parseKeyParam('banana', grid)).toBeNull()
	})

	it('resolves an empty key to 0, because Number("") is 0 — masked by the command layer', () => {
		// Faithful to upstream: parseKeyParam alone would accept `KEY=`. It never gets there in
		// practice because the command handler rejects a falsey KEY with "Missing KEY" first, so
		// this is a latent quirk rather than an observable one. Pinned so a future refactor that
		// moves the guard doesn't quietly turn it into observable behaviour.
		expect(parseKeyParam('', grid)).toEqual([0, 0])
	})

	it('prefers the row/column reading when a key could be either', () => {
		// Upstream checks the regex first, so "1/1" is never mistaken for anything else — and an
		// out-of-range row/column falls through to the numeric branch, which then also fails.
		expect(parseKeyParam('1/1', { rows: 2, columns: 2 })).toEqual([1, 1])
		expect(parseKeyParam('1/1', { rows: 1, columns: 1 })).toBeNull()
	})
})

describe('controlAt', () => {
	it('finds a control by grid position', () => {
		const layout = legacy('KEYS_TOTAL=4 KEYS_PER_ROW=2')
		if (typeof layout === 'string') throw new Error(layout)
		const surface = buildSurface(layout, false)
		expect(controlAt(surface, 1, 1)?.id).toBe('1/1')
		expect(controlAt(surface, 5, 5)).toBeUndefined()
	})
})
