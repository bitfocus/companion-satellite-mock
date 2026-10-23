import { TokenBucket, type Clock } from '../limits.js'

/** How often `replenish()` may actually refill. Bounds what a caller looping on it can extract. */
const REPLENISH_INTERVAL_MS = 2000

/**
 * A ceiling on how many pixels may be rendered per second.
 *
 * Rendering is synchronous CPU work on the one event-loop thread (the renderer uses the
 * synchronous encoders), so limiting how many renders run at once would do nothing. What bounds the
 * cost is *rate*, plus the cache. So this is a token bucket over pixels. A frame that doesn't fit
 * waits rather than closing the connection: a surface that can't keep up should skip frames, not
 * disconnect, and the next frame supersedes a waiting one anyway (see SurfaceEmitter).
 */
export class RenderBudget {
	readonly #bucket: TokenBucket
	readonly #now: Clock
	#lastReplenish = -Infinity
	#dropped = 0

	constructor(pixelsPerSecond: number, burstPixels = pixelsPerSecond, now: Clock = Date.now) {
		this.#now = now
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
		return this.tryConsumePixels(width * height)
	}

	/** As `tryConsume`, for a total across several bitmaps that must go out together or not at all. */
	tryConsumePixels(pixels: number): boolean {
		if (this.#bucket.take(pixels)) return true
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
		return this.canEverAffordPixels(width * height)
	}

	canEverAffordPixels(pixels: number): boolean {
		return pixels <= this.#bucket.capacity
	}

	/**
	 * Refill to a full burst.
	 *
	 * For a deliberate one-off repaint — a scenario switch — that should land at once rather than
	 * trickle in as the bucket refills. The trigger is reachable from the public UI, and the tRPC
	 * limiter alone would still allow several free bursts a second, so this refills at most once per
	 * REPLENISH_INTERVAL_MS and is otherwise a no-op. Worst case is the sustained rate plus one extra
	 * burst per interval.
	 */
	replenish(): void {
		const now = this.#now()
		if (now - this.#lastReplenish < REPLENISH_INTERVAL_MS) return
		this.#lastReplenish = now
		this.#bucket.fill()
	}

	get dropped(): number {
		return this.#dropped
	}

	get available(): number {
		return this.#bucket.available
	}
}
