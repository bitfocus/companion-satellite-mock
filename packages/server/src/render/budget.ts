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

	constructor(pixelsPerSecond: number, now?: Clock) {
		// Burst of one second's worth: a full surface redraw arrives as one clump and should not be
		// throttled just for being simultaneous.
		this.#bucket = new TokenBucket(pixelsPerSecond, pixelsPerSecond, now)
	}

	/** Returns false when the frame should be skipped. */
	tryConsume(width: number, height: number): boolean {
		if (this.#bucket.take(width * height)) return true
		this.#dropped++
		return false
	}

	get dropped(): number {
		return this.#dropped
	}

	get available(): number {
		return this.#bucket.available
	}
}
