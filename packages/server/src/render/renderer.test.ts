import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { ButtonRenderer, canvasToRgb, MAX_RENDERED_TEXT_CHARS } from './renderer.js'
import { DEFAULT_BUTTON_STYLE, styleCacheKey, type ButtonStyle } from './buttonStyle.js'
import { LruCache } from './lru.js'

const style = (overrides: Partial<ButtonStyle> = {}): ButtonStyle => ({ ...DEFAULT_BUTTON_STYLE, ...overrides })

/** Decode a `data:` url back to bytes. */
function decodeDataUrl(url: string): { mime: string; bytes: Buffer } {
	const match = /^data:([^;]+);base64,(.*)$/.exec(url)
	if (!match) throw new Error(`not a data url: ${url.slice(0, 40)}`)
	return { mime: match[1]!, bytes: Buffer.from(match[2]!, 'base64') }
}

describe('canvasToRgb', () => {
	it('packs three bytes per pixel', () => {
		const canvas = createCanvas(4, 2)
		const ctx = canvas.getContext('2d')
		ctx.fillStyle = '#ff0000'
		ctx.fillRect(0, 0, 4, 2)

		const rgb = canvasToRgb(canvas)
		expect(rgb).toHaveLength(4 * 2 * 3)
		expect([...rgb.subarray(0, 3)]).toEqual([255, 0, 0])
	})

	it('composites semi-transparent pixels onto black, matching the rgb wire format', () => {
		// The premultiplied/straight distinction, pinned. getImageData() would give ffffff here,
		// which is what Companion's premultiplyAlpha flag exists to avoid for 3-byte targets.
		const canvas = createCanvas(1, 1)
		const ctx = canvas.getContext('2d')
		ctx.fillStyle = 'rgba(255,255,255,0.5)'
		ctx.fillRect(0, 0, 1, 1)

		// Half of 255, either way it rounds: @napi-rs/canvas 1.0.13 moved from 127 to 128. What the
		// test pins is premultiplied (about half) against straight (255), not Skia's rounding.
		const rgb = canvasToRgb(canvas)
		for (const channel of rgb) expect([127, 128]).toContain(channel)

		const straight = ctx.getImageData(0, 0, 1, 1).data
		expect([straight[0], straight[1], straight[2]]).toEqual([255, 255, 255])
	})
})

describe('ButtonRenderer', () => {
	const renderer = new ButtonRenderer()

	it('renders rgb as bare base64 of the right length', () => {
		const encoded = renderer.render(style({ bgColor: '#123456' }), { width: 8, height: 8, format: 'rgb' })
		expect(encoded).not.toContain('data:')
		const bytes = Buffer.from(encoded, 'base64')
		expect(bytes).toHaveLength(8 * 8 * 3)
		expect([...bytes.subarray(0, 3)]).toEqual([0x12, 0x34, 0x56])
	})

	it('renders png and webp as self-describing data urls', () => {
		for (const format of ['png', 'webp'] as const) {
			const url = renderer.render(style({ bgColor: '#00ff00' }), { width: 16, height: 16, format })
			const { mime, bytes } = decodeDataUrl(url)
			expect(mime).toBe(`image/${format}`)
			expect(bytes.length).toBeGreaterThan(10)
		}
	})

	it('produces a fully opaque image, which is what keeps the two alpha readings in agreement', () => {
		// An invariant of the renderer, not an accident: every draw fills the whole surface first.
		// If it were ever broken, `canvas.data()` (premultiplied) and `getImageData()` (straight)
		// would diverge and the rgb path would silently darken — so check both halves directly.
		const canvas = renderer.renderToCanvas(style({ text: 'HI', bgColor: '#204080' }), 24, 24)

		const premultiplied = canvas.data()
		const straight = canvas.getContext('2d').getImageData(0, 0, 24, 24).data

		for (let i = 3; i < premultiplied.length; i += 4) {
			expect(premultiplied[i], `alpha at pixel ${(i - 3) / 4}`).toBe(255)
		}
		// Fully opaque means premultiplied and straight are byte-identical.
		expect(Buffer.from(premultiplied).equals(Buffer.from(straight))).toBe(true)
	})

	it('honours non-square sizes', () => {
		const bytes = Buffer.from(renderer.render(style(), { width: 60, height: 30, format: 'rgb' }), 'base64')
		expect(bytes).toHaveLength(60 * 30 * 3)
	})

	it('swaps dimensions for a quarter turn', () => {
		const bytes = Buffer.from(
			renderer.render(style(), { width: 60, height: 30, format: 'rgb', rotation: 90 }),
			'base64'
		)
		// Same pixel count, transposed.
		expect(bytes).toHaveLength(30 * 60 * 3)
	})

	it('renders pressed differently from unpressed', () => {
		const a = renderer.render(style({ bgColor: '#333333' }), { width: 32, height: 32, format: 'rgb' })
		const b = renderer.render(style({ bgColor: '#333333', pressed: true }), {
			width: 32,
			height: 32,
			format: 'rgb',
		})
		expect(a).not.toBe(b)
	})

	it('renders each page glyph type differently', () => {
		const options = { width: 32, height: 32, format: 'rgb' as const }
		const rendered = (['BUTTON', 'PAGEUP', 'PAGEDOWN', 'PAGENUM'] as const).map((type) =>
			renderer.render(style({ type, text: '2' }), options)
		)
		expect(new Set(rendered).size).toBe(4)
	})

	it('actually draws text — the regression that catches a container with no fonts', () => {
		const blank = renderer.renderRgb(style({ bgColor: '#000000' }), 48, 48)
		const withText = renderer.renderRgb(style({ bgColor: '#000000', text: 'ABC' }), 48, 48)
		expect(Buffer.compare(blank, withText)).not.toBe(0)
		expect([...withText].some((v) => v > 200)).toBe(true)
	})

	it('wraps on newlines', () => {
		const one = renderer.renderRgb(style({ text: 'AB' }), 48, 48)
		const two = renderer.renderRgb(style({ text: 'A\nB' }), 48, 48)
		expect(Buffer.compare(one, two)).not.toBe(0)
	})

	it('shrinks auto-sized text to fit a long string', () => {
		const short = renderer.renderRgb(style({ text: 'A', fontSize: 'auto' }), 48, 48)
		const long = renderer.renderRgb(style({ text: 'AAAAAAAAAAAAAAAAAAAA', fontSize: 'auto' }), 48, 48)
		expect(Buffer.compare(short, long)).not.toBe(0)
	})

	it('handles unicode and emoji without throwing', () => {
		for (const text of ['héllo', 'مرحبا', '日本語', '🎛️', 'a'.repeat(500)]) {
			expect(() => renderer.renderRgb(style({ text }), 32, 32)).not.toThrow()
		}
	})

	it('serves a repeated render from cache', () => {
		const fresh = new ButtonRenderer()
		const options = { width: 32, height: 32, format: 'rgb' as const }
		fresh.render(style({ text: 'X' }), options)
		expect(fresh.cacheStats.misses).toBe(1)

		for (let i = 0; i < 20; i++) fresh.render(style({ text: 'X' }), options)
		expect(fresh.cacheStats.hits).toBe(20)
		expect(fresh.cacheStats.hitRate).toBeGreaterThan(0.9)
	})

	it('does not confuse two styles that differ only in where the text ends', () => {
		// The cache-key collision the JSON encoding exists to prevent.
		const fresh = new ButtonRenderer()
		const options = { width: 16, height: 16, format: 'rgb' as const }
		const a = fresh.render(style({ text: 'AB', fontSize: 12 }), options)
		const b = fresh.render(style({ text: 'A', fontSize: 12 }), options)
		expect(a).not.toBe(b)
	})

	it('keys the cache on size, format and rotation as well as style', () => {
		const s = style({ text: 'K' })
		expect(styleCacheKey(s, 32, 32, 'rgb', 0)).not.toBe(styleCacheKey(s, 64, 32, 'rgb', 0))
		expect(styleCacheKey(s, 32, 32, 'rgb', 0)).not.toBe(styleCacheKey(s, 32, 32, 'png', 0))
		expect(styleCacheKey(s, 32, 32, 'rgb', 0)).not.toBe(styleCacheKey(s, 32, 32, 'rgb', 90))
	})

	it('renders a full 32-key surface of unique content well inside a 30fps frame', () => {
		// A regression guard rather than a target: the Phase 0 spike measured 12ms, so anything near
		// 33ms means the fast path has been lost.
		const fresh = new ButtonRenderer()
		const started = process.hrtime.bigint()
		for (let k = 0; k < 32; k++) {
			fresh.render(style({ text: `K${k}`, bgColor: `hsl(${k * 11}, 50%, 30%)` }), {
				width: 72,
				height: 72,
				format: 'rgb',
			})
		}
		const ms = Number(process.hrtime.bigint() - started) / 1e6
		expect(ms).toBeLessThan(30)
	})
})

describe('LruCache', () => {
	it('evicts the least recently used entry', () => {
		const cache = new LruCache<string>(2, 1000)
		cache.set('a', 'A', 1)
		cache.set('b', 'B', 1)
		cache.get('a') // 'b' is now the oldest
		cache.set('c', 'C', 1)

		expect(cache.get('a')).toBe('A')
		expect(cache.get('b')).toBeUndefined()
		expect(cache.get('c')).toBe('C')
	})

	it('evicts on the byte budget too, not just entry count', () => {
		const cache = new LruCache<string>(100, 10)
		cache.set('a', 'A', 6)
		cache.set('b', 'B', 6)
		expect(cache.get('a')).toBeUndefined()
		expect(cache.get('b')).toBe('B')
	})

	it('replaces an existing key without double-counting its bytes', () => {
		const cache = new LruCache<string>(10, 100)
		cache.set('a', 'A', 10)
		cache.set('a', 'AA', 20)
		expect(cache.stats.entries).toBe(1)
		expect(cache.stats.bytes).toBe(20)
	})

	it('reports a hit rate', () => {
		const cache = new LruCache<string>(10, 100)
		cache.set('a', 'A', 1)
		cache.get('a')
		cache.get('b')
		expect(cache.stats).toMatchObject({ hits: 1, misses: 1, hitRate: 0.5 })
	})
})

describe('untrusted text', () => {
	it('bounds what it lays out, so a huge label cannot hold the event loop', () => {
		// A satellite client can get a 256KB string drawn onto a key (a variable name the Variables
		// scenario echoes). Laid out in full that took 1.4s per render.
		const renderer = new ButtonRenderer()
		const started = performance.now()
		renderer.render(
			{ ...DEFAULT_BUTTON_STYLE, text: 'W'.repeat(250_000) },
			{ width: 72, height: 72, format: 'rgb' }
		)
		renderer.render(
			{ ...DEFAULT_BUTTON_STYLE, text: 'W\n'.repeat(100_000) },
			{ width: 72, height: 72, format: 'rgb' }
		)
		expect(performance.now() - started).toBeLessThan(200)
	})

	it('cuts an over-long label at the limit, by code point', () => {
		const renderer = new ButtonRenderer()
		const options = { width: 72, height: 72, format: 'rgb' } as const
		const prefix = '🎥'.repeat(MAX_RENDERED_TEXT_CHARS)
		expect(renderer.render({ ...DEFAULT_BUTTON_STYLE, text: `${prefix}tail` }, options)).toBe(
			renderer.render({ ...DEFAULT_BUTTON_STYLE, text: prefix }, options)
		)
		// Short text is untouched: one character less renders differently.
		expect(renderer.render({ ...DEFAULT_BUTTON_STYLE, text: 'CAM 1' }, options)).not.toBe(
			renderer.render({ ...DEFAULT_BUTTON_STYLE, text: 'CAM ' }, options)
		)
	})
})
