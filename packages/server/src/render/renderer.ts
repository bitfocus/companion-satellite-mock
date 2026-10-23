import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import type { BitmapFormat } from '@satellite-mock/protocol'
import { DEFAULT_BUTTON_STYLE, styleCacheKey, type ButtonStyle } from './buttonStyle.js'
import { LruCache } from './lru.js'
import { drawPattern } from './patterns.js'

export type Rotation = 0 | 90 | -90 | 180

export interface RenderOptions {
	width: number
	height: number
	format: BitmapFormat
	rotation?: Rotation
}

export interface RendererOptions {
	maxCacheEntries?: number
	maxCacheBytes?: number
}

/**
 * Renders button images.
 *
 * The alpha handling here is the part to be careful with, and it has bitten Companion. For the
 * speed side, see scripts/bench-render.mjs and docs/protocol.md §7. The rules:
 *
 * - `canvas.data()` returns PREMULTIPLIED rgba. Dropping the alpha channel from it composites onto
 *   black, which is exactly what the `rgb` wire format is — Companion's `transformButtonImage` sets
 *   `premultiplyAlpha` for 3-byte targets for the same reason. So `data()` is both the fast path and
 *   the correct one for `rgb`.
 * - `getImageData()` returns STRAIGHT rgba. Dropping alpha from that ignores transparency entirely
 *   and produces the wrong colour.
 * - `png`/`webp` keep the alpha channel, so they must be encoded from the canvas itself, which
 *   handles straight alpha correctly. Never hand an encoder `data()` bytes: premultiplied values
 *   written as straight ones darken every semi-transparent pixel.
 */
export class ButtonRenderer {
	readonly #cache: LruCache<Buffer | string>

	constructor(options: RendererOptions = {}) {
		this.#cache = new LruCache(options.maxCacheEntries ?? 4096, options.maxCacheBytes ?? 64 * 1024 * 1024)
	}

	get cacheStats() {
		return this.#cache.stats
	}

	clearCache(): void {
		this.#cache.clear()
	}

	/**
	 * Render to the negotiated wire representation: bare base64 for `rgb`, a `data:` url otherwise.
	 * The client distinguishes them by the `data:` prefix.
	 */
	render(unbounded: ButtonStyle, options: RenderOptions): string {
		const style = boundText(unbounded)
		const rotation = options.rotation ?? 0
		const key = styleCacheKey(style, options.width, options.height, options.format, rotation)

		const cached = this.#cache.get(key)
		if (cached !== undefined) return typeof cached === 'string' ? cached : cached.toString('base64')

		const canvas = this.#draw(style, options.width, options.height, rotation)

		if (options.format === 'rgb') {
			const buffer = canvasToRgb(canvas)
			this.#cache.set(key, buffer, buffer.length)
			return buffer.toString('base64')
		}

		// Branched rather than passing a union: `toBuffer` overloads png separately from the
		// quality-taking formats, so a union argument fails to resolve.
		const encoded = options.format === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/webp')
		const mime = options.format === 'png' ? 'image/png' : 'image/webp'
		const dataUrl = `data:${mime};base64,${encoded.toString('base64')}`
		this.#cache.set(key, dataUrl, dataUrl.length)
		return dataUrl
	}

	/** Raw RGB bytes, for tests and for anything that needs the buffer rather than base64. */
	renderRgb(style: ButtonStyle, width: number, height: number, rotation: Rotation = 0): Buffer {
		return canvasToRgb(this.#draw(boundText(style), width, height, rotation))
	}

	/**
	 * The drawn canvas itself, uncached.
	 *
	 * Exposed so the opacity invariant can be checked directly rather than inferred, and so the LED
	 * sampler can read pixels without a round trip through an encoder.
	 */
	renderToCanvas(style: ButtonStyle, width: number, height: number, rotation: Rotation = 0): Canvas {
		return this.#draw(boundText(style), width, height, rotation)
	}

	#draw(style: ButtonStyle, width: number, height: number, rotation: Rotation): Canvas {
		const swap = rotation === 90 || rotation === -90
		const canvas = createCanvas(swap ? height : width, swap ? width : height)
		const ctx = canvas.getContext('2d')

		if (rotation !== 0) {
			ctx.translate(canvas.width / 2, canvas.height / 2)
			ctx.rotate((rotation * Math.PI) / 180)
			ctx.translate(-width / 2, -height / 2)
		}

		drawButton(ctx, style, width, height)
		return canvas
	}
}

/** More than any key can show legibly, and far below what costs real time to lay out. */
export const MAX_RENDERED_TEXT_CHARS = 200
export const MAX_RENDERED_TEXT_LINES = 8

/**
 * Cut text down to what a key could ever show, before it is laid out or used as a cache key.
 *
 * Button text can come from the satellite client (variable names and control ids are echoed by
 * some scenarios), and a line may be 256KB. Laying that out took 1.4s of the server's only thread
 * per render, which one connection could repeat twice a second; as a cache key it would also have
 * been stored in full, with the cache counting only the rendered value toward its byte limit.
 */
function boundText(style: ButtonStyle): ButtonStyle {
	if (style.text.length <= MAX_RENDERED_TEXT_CHARS && !style.text.includes('\n')) return style
	const lines = style.text
		.slice(0, MAX_RENDERED_TEXT_CHARS * 2)
		.split('\n')
		.slice(0, MAX_RENDERED_TEXT_LINES)
	// By code point, so an emoji or other astral character is never cut in half.
	const text = Array.from(lines.join('\n')).slice(0, MAX_RENDERED_TEXT_CHARS).join('')
	return text === style.text ? style : { ...style, text }
}

/**
 * Fill the whole surface first, unconditionally.
 *
 * This is what keeps every pixel opaque, which is what makes `canvas.data()` and `getImageData()`
 * agree. It is an invariant of the renderer, not a happy accident, and renderer.test.ts checks both
 * halves of it directly rather than inferring it.
 */
function drawButton(ctx: SKRSContext2D, style: ButtonStyle, width: number, height: number): void {
	ctx.fillStyle = style.bgColor
	ctx.fillRect(0, 0, width, height)
	// A labelled pattern stops above the label strip rather than being drawn underneath it, so two-part
	// patterns (red text on black then on blue, dark then light levels) keep both parts visible.
	const labelled = style.pattern && style.pattern !== 'markers' && style.text
	if (style.pattern) drawPattern(ctx, style.pattern, width, labelled ? height - labelStrip(height) : height)

	if (style.pressed) {
		ctx.strokeStyle = '#ffffff'
		ctx.lineWidth = Math.max(2, Math.min(width, height) / 16)
		ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth)
	}

	if (style.type !== 'BUTTON') {
		drawPageGlyph(ctx, style, width, height)
		return
	}

	if (style.pattern) {
		// The marker pattern leaves its middle clear for ordinary text; the rest need it out of the way.
		if (style.text) {
			if (style.pattern === 'markers') drawText(ctx, style, width, height)
			else drawLabel(ctx, style, width, height)
		}
		return
	}

	if (style.text) drawText(ctx, style, width, height)
}

const labelStrip = (height: number) => Math.min(height, Math.max(9, Math.round(height / 5)))

/** A small label in a strip along the bottom edge, for keys whose content is a test pattern. */
function drawLabel(ctx: SKRSContext2D, style: ButtonStyle, width: number, height: number): void {
	const strip = labelStrip(height)
	ctx.fillStyle = '#000000'
	ctx.fillRect(0, height - strip, width, strip)

	ctx.fillStyle = style.textColor
	ctx.font = `${strip - 3}px sans-serif`
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillText(style.text.replace(/\n/g, ' '), width / 2, height - strip / 2, width - 2)
}

function drawPageGlyph(ctx: SKRSContext2D, style: ButtonStyle, width: number, height: number): void {
	ctx.fillStyle = style.textColor
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'

	if (style.type === 'PAGENUM') {
		ctx.font = `${Math.round(Math.min(width, height) / 2.5)}px sans-serif`
		ctx.fillText(style.text || '1', width / 2, height / 2)
		return
	}

	// A filled triangle, up or down, rather than a glyph from a font we may not have.
	const up = style.type === 'PAGEUP'
	const w = width * 0.4
	const h = height * 0.3
	const cx = width / 2
	const cy = height / 2
	ctx.beginPath()
	if (up) {
		ctx.moveTo(cx, cy - h / 2)
		ctx.lineTo(cx + w / 2, cy + h / 2)
		ctx.lineTo(cx - w / 2, cy + h / 2)
	} else {
		ctx.moveTo(cx, cy + h / 2)
		ctx.lineTo(cx + w / 2, cy - h / 2)
		ctx.lineTo(cx - w / 2, cy - h / 2)
	}
	ctx.closePath()
	ctx.fill()
}

function drawText(ctx: SKRSContext2D, style: ButtonStyle, width: number, height: number): void {
	const lines = style.text.split('\n')
	const size = style.fontSize === 'auto' ? autoFontSize(ctx, lines, width, height) : style.fontSize

	ctx.fillStyle = style.textColor
	ctx.font = `${size}px sans-serif`
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'

	const lineHeight = size * 1.2
	const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2
	lines.forEach((line, index) => {
		ctx.fillText(line, width / 2, startY + index * lineHeight)
	})
}

/**
 * Pick the largest size that fits, by measuring.
 *
 * Companion's own auto-sizing is more elaborate; this approximates it. The mock's job is to exercise
 * a client's rendering and layout, not to be pixel-identical to Companion — and a scenario that
 * needs an exact size can always ask for one.
 */
function autoFontSize(ctx: SKRSContext2D, lines: string[], width: number, height: number): number {
	const maxByHeight = Math.floor(height / (lines.length * 1.3))
	let size = Math.min(maxByHeight, Math.floor(height / 2.5))

	while (size > 6) {
		ctx.font = `${size}px sans-serif`
		const widest = Math.max(...lines.map((line) => ctx.measureText(line).width))
		if (widest <= width * 0.9) break
		size--
	}
	return Math.max(6, size)
}

/**
 * Premultiplied rgba to packed rgb.
 *
 * `canvas.data()` is ~13x cheaper than `getImageData()` and is the correct source for `rgb` (see the
 * class comment). The loop is written with explicit indexing rather than `o++` per channel because
 * that alone measured 3.4x faster — together they take a cold 32-key surface from 44ms to 12ms.
 */
export function canvasToRgb(canvas: Canvas): Buffer {
	const src = canvas.data()
	const pixels = canvas.width * canvas.height
	const out = Buffer.allocUnsafe(pixels * 3)
	for (let i = 0, o = 0; i < pixels; i++, o += 3) {
		const p = i << 2
		out[o] = src[p] as number
		out[o + 1] = src[p + 1] as number
		out[o + 2] = src[p + 2] as number
	}
	return out
}

export { DEFAULT_BUTTON_STYLE, type ButtonStyle }
