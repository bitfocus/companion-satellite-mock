import { normaliseIp } from './limits.js'

/** Nothing may hold an address out longer than this, whatever the caller asks for. */
export const MAX_BLACKOUT_MS = 60_000

export interface BlackoutState {
	/** Milliseconds still to run. */
	remainingMs: number
	until: number
}

/**
 * Temporarily refuses new connections from an address, so a client's reconnect loop can be tested.
 *
 * Disconnecting a client tests one thing: that it notices. What actually breaks in the field is the
 * loop that follows — a client that gives up after three tries, backs off to an hour, or spins at
 * full speed until the battery dies. None of that is visible unless the server stays unreachable
 * for a while, which is what this is for.
 *
 * Two properties make it a test tool rather than a denial-of-service primitive: every entry has a
 * hard ceiling on its duration and expires on its own, and the caller can only ever name the
 * address its own connection is coming from (enforced at the API layer, see `web/trpc.ts`). The
 * worst an operator can do is take themselves offline for a minute.
 *
 * Keyed by `normaliseIp` for the same reason the connection limits are: a client with a routed IPv6
 * prefix would otherwise walk out of the blackout by picking a new address.
 */
export class ReconnectBlackout {
	readonly #until = new Map<string, number>()

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Hold an address out for `durationMs`, capped. Returns when it will expire.
	 *
	 * Overlapping calls extend rather than shorten: a second call for a shorter window would
	 * otherwise be a way to cancel one, and cancelling has its own method.
	 */
	add(ip: string, durationMs: number): number {
		const capped = Math.min(Math.max(0, Math.floor(durationMs)), MAX_BLACKOUT_MS)
		const key = normaliseIp(ip)
		const until = this.now() + capped

		const existing = this.#until.get(key)
		const resolved = existing !== undefined && existing > until ? existing : until
		this.#until.set(key, resolved)
		return resolved
	}

	clear(ip: string): void {
		this.#until.delete(normaliseIp(ip))
	}

	/** Whether an address is currently held out. Expired entries are dropped as they are seen. */
	blocks(ip: string): boolean {
		const key = normaliseIp(ip)
		const until = this.#until.get(key)
		if (until === undefined) return false
		if (until <= this.now()) {
			this.#until.delete(key)
			return false
		}
		return true
	}

	state(ip: string): BlackoutState | undefined {
		const until = this.#until.get(normaliseIp(ip))
		if (until === undefined || until <= this.now()) return undefined
		return { until, remainingMs: until - this.now() }
	}

	/** Drop expired entries, so the map does not grow once per address seen, forever. */
	sweep(): number {
		const now = this.now()
		let removed = 0
		for (const [key, until] of this.#until) {
			if (until <= now) {
				this.#until.delete(key)
				removed++
			}
		}
		return removed
	}

	get size(): number {
		return this.#until.size
	}
}
