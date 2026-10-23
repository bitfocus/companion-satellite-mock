import type { SKRSContext2D } from '@napi-rs/canvas'

/**
 * Test patterns for checking a client's image pipeline, drawn pixel-exact.
 *
 * Most are aimed at what a device's encoder does to colour. Many surfaces convert to YUV with
 * chroma subsampled — 4:2:2 halves colour resolution horizontally, 4:2:0 in both directions — and
 * a client that gets that wrong only shows it on fine colour detail, which ordinary button content
 * rarely has. Each pattern pairs with a black-and-white control (`luma-stripes`) so a softened
 * colour pattern can be told apart from a scaled or blurred image.
 *
 * Everything is integer `fillRect`, never stroked or anti-aliased, so the pixels sent are exactly
 * the pixels described here.
 */
export const TEST_PATTERNS = [
	'markers',
	'luma-stripes',
	'chroma-stripes',
	'isoluminant',
	'chroma-checker',
	'colour-edges',
	'red-text',
	'gradients',
	'levels',
] as const

export type TestPattern = (typeof TEST_PATTERNS)[number]

/** Short names for the label strip; the key is small. */
export const PATTERN_LABELS: Record<TestPattern, string> = {
	markers: 'markers',
	'luma-stripes': 'B/W 1px',
	'chroma-stripes': 'R/B 1px',
	isoluminant: 'R/G iso',
	'chroma-checker': 'R/G chk',
	'colour-edges': 'edges',
	'red-text': 'red text',
	gradients: 'ramps',
	levels: 'levels',
}

/**
 * Pure red and a green of the same luma (BT.601: 0.299 × 255 ≈ 76, 0.587 × 130 ≈ 76).
 *
 * Alternate them in 1px columns and there is no brightness detail left at all, only colour — so a
 * 4:2:2 encoder averages each pair into one flat brown and the stripes vanish entirely. The most
 * unambiguous test here: stripes visible means full chroma, a flat patch means subsampled.
 */
const ISO_RED = '#ff0000'
const ISO_GREEN = '#008200'

export function drawPattern(ctx: SKRSContext2D, pattern: TestPattern, width: number, height: number): void {
	switch (pattern) {
		case 'markers':
			return markers(ctx, width, height)
		case 'luma-stripes':
			return columns(ctx, width, height, ['#ffffff', '#000000'])
		case 'chroma-stripes':
			return columns(ctx, width, height, ['#ff0000', '#0000ff'])
		case 'isoluminant':
			return columns(ctx, width, height, [ISO_RED, ISO_GREEN])
		case 'chroma-checker':
			return checker(ctx, width, height, '#ff0000', '#00ff00')
		case 'colour-edges':
			return colourEdges(ctx, width, height)
		case 'red-text':
			return redText(ctx, width, height)
		case 'gradients':
			return gradients(ctx, width, height)
		case 'levels':
			return levels(ctx, width, height)
	}
}

/** One-pixel vertical columns cycling through `colours`: the finest horizontal detail possible. */
function columns(ctx: SKRSContext2D, width: number, height: number, colours: string[]): void {
	for (let x = 0; x < width; x++) {
		ctx.fillStyle = colours[x % colours.length]!
		ctx.fillRect(x, 0, 1, height)
	}
}

/** One-pixel checkerboard: fine detail in both directions, which 4:2:0 loses and 4:2:2 half-loses. */
function checker(ctx: SKRSContext2D, width: number, height: number, a: string, b: string): void {
	ctx.fillStyle = a
	ctx.fillRect(0, 0, width, height)
	ctx.fillStyle = b
	for (let y = 0; y < height; y++) {
		for (let x = y % 2; x < width; x += 2) ctx.fillRect(x, y, 1, 1)
	}
}

/**
 * Saturated bands three pixels wide, so successive edges fall on odd and even columns.
 *
 * A 4:2:2 encoder pairs columns (0,1), (2,3)… — an edge between a pair survives, an edge inside one
 * gets a fringe of the averaged colour. Seeing every other edge fringed is the signature.
 */
function colourEdges(ctx: SKRSContext2D, width: number, height: number): void {
	const bands = ['#ff0000', '#00ffff', '#0000ff', '#ffff00', '#ff00ff', '#00ff00']
	for (let x = 0, i = 0; x < width; x += 3, i++) {
		ctx.fillStyle = bands[i % bands.length]!
		ctx.fillRect(x, 0, 3, height)
	}
}

/**
 * Small red text on black, then on blue.
 *
 * The case that actually shows up in the field: a red tally or a red label smearing into a pink
 * halo on a device whose encoder subsamples chroma. Red on blue is the harshest, since the two
 * differ almost entirely in colour rather than brightness.
 */
function redText(ctx: SKRSContext2D, width: number, height: number): void {
	const half = Math.floor(height / 2)
	ctx.fillStyle = '#000000'
	ctx.fillRect(0, 0, width, half)
	ctx.fillStyle = '#0000ff'
	ctx.fillRect(0, half, width, height - half)

	ctx.fillStyle = '#ff0000'
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.font = `bold ${Math.max(8, Math.round(height / 5))}px sans-serif`
	ctx.fillText('RED', width / 2, half / 2)
	ctx.fillText('RED', width / 2, half + (height - half) / 2)
}

/** A hue sweep over a grey ramp: shows banding, and a ramp that clips or crushes at either end. */
function gradients(ctx: SKRSContext2D, width: number, height: number): void {
	const half = Math.floor(height / 2)
	for (let x = 0; x < width; x++) {
		const t = width > 1 ? x / (width - 1) : 0
		ctx.fillStyle = `hsl(${Math.round(t * 360)} 100% 50%)`
		ctx.fillRect(x, 0, 1, half)
		const grey = Math.round(t * 255)
		ctx.fillStyle = `rgb(${grey},${grey},${grey})`
		ctx.fillRect(x, half, 1, height - half)
	}
}

/**
 * Steps just above black and just below white.
 *
 * Video-range YUV puts black at 16 and white at 235. A client that converts with the wrong range
 * crushes the top row into one black and the bottom row into one white, so the steps disappear.
 */
function levels(ctx: SKRSContext2D, width: number, height: number): void {
	const dark = [0, 8, 16, 24, 32, 48]
	const light = [208, 224, 235, 240, 248, 255]
	const half = Math.floor(height / 2)
	const step = width / dark.length
	for (let i = 0; i < dark.length; i++) {
		const x = Math.round(i * step)
		const w = Math.round((i + 1) * step) - x
		ctx.fillStyle = `rgb(${dark[i]},${dark[i]},${dark[i]})`
		ctx.fillRect(x, 0, w, half)
		ctx.fillStyle = `rgb(${light[i]},${light[i]},${light[i]})`
		ctx.fillRect(x, half, w, height - half)
	}
}

/**
 * Orientation and geometry: a differently coloured square in each corner, and a one-pixel frame.
 *
 * Mirrored, flipped or rotated output moves the corners; a cropped or offset image loses part of
 * the frame; a wrong row stride shears the frame's vertical edges into diagonals.
 */
function markers(ctx: SKRSContext2D, width: number, height: number): void {
	ctx.fillStyle = '#202020'
	ctx.fillRect(0, 0, width, height)

	ctx.fillStyle = '#ffffff'
	ctx.fillRect(0, 0, width, 1)
	ctx.fillRect(0, height - 1, width, 1)
	ctx.fillRect(0, 0, 1, height)
	ctx.fillRect(width - 1, 0, 1, height)

	const size = Math.max(4, Math.round(Math.min(width, height) / 6))
	const corners: [number, number, string][] = [
		[2, 2, '#ff0000'],
		[width - 2 - size, 2, '#00ff00'],
		[2, height - 2 - size, '#0000ff'],
		[width - 2 - size, height - 2 - size, '#ffff00'],
	]
	for (const [x, y, colour] of corners) {
		ctx.fillStyle = colour
		ctx.fillRect(x, y, size, size)
	}
}
