#!/usr/bin/env node
/**
 * Rendering benchmark.
 *
 * The numbers behind the bitmap format advice in docs/protocol.md §7. A measurement that cannot be
 * re-run will eventually be wrong, so it lives here rather than only in prose.
 *
 * Usage: node scripts/bench-render.mjs
 *
 * `@julusian/image-rs` is compared when it is installed and skipped otherwise — it is not a
 * dependency of this project, only a candidate that was evaluated.
 */
import { createCanvas } from '@napi-rs/canvas'

const W = 72
const H = 72
const N = 2000
const PARALLEL = 200

function drawButton(i) {
	const canvas = createCanvas(W, H)
	const ctx = canvas.getContext('2d')
	ctx.fillStyle = `hsl(${i % 360} 60% 35%)`
	ctx.fillRect(0, 0, W, H)
	ctx.fillStyle = '#ffffff'
	ctx.font = '14px sans-serif'
	ctx.fillText(`CAM ${i % 100}`, 6, 40)
	return canvas
}

/** The conversion the renderer actually ships — see render/renderer.ts. */
function canvasToRgb(canvas) {
	const src = canvas.data()
	const pixels = canvas.width * canvas.height
	const out = Buffer.allocUnsafe(pixels * 3)
	for (let i = 0, o = 0; i < pixels; i++, o += 3) {
		const p = i << 2
		out[o] = src[p]
		out[o + 1] = src[p + 1]
		out[o + 2] = src[p + 2]
	}
	return out
}

/** The naive version, kept so the gap it opens stays visible rather than folklore. */
function naiveToRgb(canvas) {
	const src = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
	const out = Buffer.allocUnsafe(canvas.width * canvas.height * 3)
	let o = 0
	for (let i = 0; i < src.length; i += 4) {
		out[o++] = src[i]
		out[o++] = src[i + 1]
		out[o++] = src[i + 2]
	}
	return out
}

/**
 * Time `fn` over freshly drawn buttons.
 *
 * The draw is inside the timed region and measured separately, so it can be subtracted. An earlier
 * version pre-built the canvases and timed only `fn`, which reported "draw only" as 0.000 ms/op —
 * it was timing an identity function over an already-drawn array.
 */
async function time(label, fn, runs = 3) {
	const perRun = []
	for (let run = 0; run < runs; run++) {
		for (let i = 0; i < 100; i++) await fn(drawButton(i))
		const start = process.hrtime.bigint()
		for (let i = 0; i < N; i++) await fn(drawButton(i))
		perRun.push(Number(process.hrtime.bigint() - start) / 1e6 / N)
	}
	const best = Math.min(...perRun)
	const worst = Math.max(...perRun)
	console.log(`  ${label.padEnd(38)} ${best.toFixed(3).padStart(7)} ms/op  (worst ${worst.toFixed(3)})`)
	return best
}

/**
 * How much of the event loop the work leaves free.
 *
 * Ticks of a 1 ms interval during the run: zero means the loop was blocked throughout, which is what
 * a synchronous encode does to every other connection on the server.
 */
async function eventLoop(label, run, runs = 3) {
	const results = []
	for (let attempt = 0; attempt < runs; attempt++) {
		const canvases = Array.from({ length: PARALLEL }, (_, i) => drawButton(i))
		let ticks = 0
		const timer = setInterval(() => ticks++, 1)
		const start = process.hrtime.bigint()
		await run(canvases)
		const ms = Number(process.hrtime.bigint() - start) / 1e6
		clearInterval(timer)
		results.push({ ms, ticks })
	}
	const ms = Math.min(...results.map((r) => r.ms))
	const ticks = results.map((r) => r.ticks)
	console.log(`  ${label.padEnd(38)} ${ms.toFixed(0).padStart(5)} ms   ticks free: ${ticks.join(', ')}`)
}

console.log(`\nnode ${process.version}, ${(await import('node:os')).availableParallelism()} cpus, ${W}×${H} buttons\n`)

console.log('Per-operation cost:')
const drawMs = await time('draw only', () => undefined)
const rgbMs = await time('rgb: canvas.data() + indexed loop', canvasToRgb)
await time('rgb: getImageData() + naive loop', naiveToRgb)
const pngMs = await time('png: canvas.toBuffer (sync)', (c) => c.toBuffer('image/png'))
await time('webp: canvas.toBuffer (sync)', (c) => c.toBuffer('image/webp'))

let imageRs
try {
	imageRs = (await import('@julusian/image-rs')).ImageTransformer
} catch {
	console.log('\n  (@julusian/image-rs not installed — skipping its comparison)')
}
if (imageRs) {
	await time('rgb: image-rs sync (premultiplied src)', (c) =>
		imageRs.fromBuffer(c.data(), W, H, 'rgba').toBufferSync('rgb', { premultiplyAlpha: false })
	)
	await time('rgb: image-rs async', (c) =>
		imageRs.fromBuffer(c.data(), W, H, 'rgba').toBuffer('rgb', { premultiplyAlpha: false })
	)
}

console.log('\nEvent loop, %d operations in parallel:', PARALLEL)
await eventLoop('png: canvas.toBuffer (sync)', async (cs) => {
	for (const c of cs) c.toBuffer('image/png')
})
await eventLoop('png: canvas.encode (promise)', (cs) => Promise.all(cs.map((c) => c.encode('png'))))
if (imageRs) {
	await eventLoop('png: image-rs toDataUrl (async)', (cs) =>
		Promise.all(cs.map((c) => imageRs.fromBuffer(c.data(), W, H, 'rgba').toDataUrl('png')))
	)
}

// --- correctness, not speed: the alpha rule the renderer depends on ---
const probe = createCanvas(W, H)
const pctx = probe.getContext('2d')
pctx.clearRect(0, 0, W, H)
pctx.fillStyle = 'rgba(255,255,255,0.5)'
pctx.fillRect(0, 0, W, H)

console.log('\nAlpha handling (50% white over nothing → rgb):')
console.log(
	`  canvas.data()   (premultiplied)  ${canvasToRgb(probe).subarray(0, 3).toString('hex')}  correct: composited on black`
)
console.log(
	`  getImageData()  (straight)       ${naiveToRgb(probe).subarray(0, 3).toString('hex')}  wrong: alpha ignored`
)

const sample = drawButton(1)
console.log('\nWire size:')
console.log(`  rgb  ${canvasToRgb(sample).length} B`)
console.log(`  png  ${sample.toBuffer('image/png').length} B`)
console.log(`  webp ${sample.toBuffer('image/webp').length} B`)

console.log(
	`\nSummary: png costs ${(pngMs / rgbMs).toFixed(1)}× the CPU of rgb and ${(canvasToRgb(sample).length / sample.toBuffer('image/png').length).toFixed(0)}× less bandwidth.`
)
console.log(`Draw alone is ${((drawMs / rgbMs) * 100).toFixed(0)}% of the rgb path.\n`)
