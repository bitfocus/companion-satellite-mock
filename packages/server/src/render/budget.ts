import { TokenBucket, type Clock } from '../limits.js'

/**
 * A ceiling on how many pixels may be rendered per second.
 *
 * The design originally called for a "render semaphore" limiting concurrent renders. That would do
 * nothing: the Phase 0 spike measured `canvas.encode()` failing to free the event loop (200 parallel
 * encodes ticked a 1ms interval twice), so rendering is effectively synchronous CPU work on one
 * thread. Concurrency is already one; limiting it to four is a no-op.
 *
 * What actually bounds the cost is *rate* plus the cache. So this is a token bucket over pixels,
 * and exceeding it drops the frame rather than closing the connection — a surface that cannot keep
 * up should skip frames, not disconnect, and the next draw for the same control supersedes it
 * anyway.
 */
export class RenderBudget {
	readonly #bucket: TokenBucket
	#dropped = 0

	constructor(pixelsPerSecond: number, burstPixels = pixelsPerSecond, now?: Clock) {
		// A full surface redraw arrives as one clump and must not be throttled just for being
		// simultaneous — so the burst capacity has to hold at least one whole repaint. One second's
		// worth is enough for a small surface but *not* for a large hi-DPI one (a 63-key surface at
		// 226px is ~2.6M pixels, more than the default one-second budget), and the shortfall silently
		// truncates the cold paint: the bucket drains mid-flush, the tail keys are sent with no bitmap,
		// and on a bitmap-only surface they stay blank forever because nothing redraws them. Callers
		// that know their surface size pass it as `burstPixels`. The refill rate is still the sustained
		// throughput throttle; only the instantaneous burst grows.
		this.#bucket = new TokenBucket(Math.max(pixelsPerSecond, burstPixels), pixelsPerSecond, now)
	}

	/** Returns false when the frame should be skipped. */
	tryConsume(width: number, height: number): boolean {
		if (this.#bucket.take(width * height)) return true
		this.#dropped++
		return false
	}

	/**
	 * Whether a frame this size could *ever* fit, given a full bucket.
	 *
	 * Guards deferral: a caller that re-queues an over-budget frame to retry it later must not re-queue
	 * one larger than the whole budget, or it would retry forever. Such a frame is dropped instead.
	 */
	canEverAfford(width: number, height: number): boolean {
		return width * height <= this.#bucket.capacity
	}

	get dropped(): number {
		return this.#dropped
	}

	get available(): number {
		return this.#bucket.available
	}
}
