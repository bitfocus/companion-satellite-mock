/**
 * Rate limiting and connection accounting.
 *
 * All of it is clock-injectable, because a rate limiter you cannot test deterministically is a rate
 * limiter nobody trusts enough to set aggressively.
 */

export type Clock = () => number

/**
 * A token bucket: `capacity` tokens, refilled at `refillPerSecond`.
 *
 * Burst is the capacity, sustained rate is the refill. Sized here against the *reference client*,
 * which pings at 10 Hz — not against the spec's suggested 2 s interval, which would leave the
 * default limits an order of magnitude too tight. See docs/protocol.md §4.
 */
export class TokenBucket {
	#tokens: number
	#lastRefill: number

	constructor(
		readonly capacity: number,
		readonly refillPerSecond: number,
		private readonly now: Clock = Date.now
	) {
		if (capacity <= 0) throw new Error('capacity must be positive')
		if (refillPerSecond <= 0) throw new Error('refillPerSecond must be positive')
		this.#tokens = capacity
		this.#lastRefill = now()
	}

	#refill(): void {
		const now = this.now()
		const elapsedMs = now - this.#lastRefill
		if (elapsedMs <= 0) return
		this.#tokens = Math.min(this.capacity, this.#tokens + (elapsedMs / 1000) * this.refillPerSecond)
		this.#lastRefill = now
	}

	/** Take `count` tokens if available. Returns false without partially consuming. */
	take(count = 1): boolean {
		this.#refill()
		if (this.#tokens < count) return false
		this.#tokens -= count
		return true
	}

	get available(): number {
		this.#refill()
		return this.#tokens
	}

	/** Top the bucket back to full. For a deliberate, one-off burst that should not be throttled. */
	fill(): void {
		this.#refill()
		this.#tokens = this.capacity
	}
}

/**
 * One token bucket per address, keyed by `normaliseIp`, with a bounded number of entries.
 *
 * For limits on the public web UI, where the browser's own id is client-chosen and so cannot be
 * what a limit is keyed on. A full bucket behaves exactly like a missing one, so those are dropped
 * whenever the map reaches `maxEntries`; if that frees nothing, the oldest entry goes. Evicting
 * hands that address a fresh allowance, but forcing it means cycling through `maxEntries` distinct
 * addresses (or /64s), which is exactly what per-address limiting already assumes is expensive.
 */
export class AddressBuckets {
	readonly #buckets = new Map<string, TokenBucket>()

	constructor(
		private readonly capacity: number,
		private readonly refillPerSecond: number,
		private readonly maxEntries = 10_000,
		private readonly now: Clock = Date.now
	) {}

	take(ip: string, count = 1): boolean {
		return this.#bucketFor(normaliseIp(ip)).take(count)
	}

	get size(): number {
		return this.#buckets.size
	}

	#bucketFor(key: string): TokenBucket {
		const existing = this.#buckets.get(key)
		if (existing) return existing

		if (this.#buckets.size >= this.maxEntries) {
			for (const [other, bucket] of this.#buckets) {
				if (bucket.available >= bucket.capacity) this.#buckets.delete(other)
			}
			if (this.#buckets.size >= this.maxEntries) {
				const oldest = this.#buckets.keys().next().value
				if (oldest !== undefined) this.#buckets.delete(oldest)
			}
		}

		const bucket = new TokenBucket(this.capacity, this.refillPerSecond, this.now)
		this.#buckets.set(key, bucket)
		return bucket
	}
}

export interface ConnectionLimits {
	maxTotal: number
	maxPerIp: number
	perIpPerMinute: number
	burstPerIp: number
}

export type AdmissionResult =
	{ ok: true } | { ok: false; reason: 'server-full' | 'too-many-for-ip' | 'connecting-too-fast' }

/**
 * Tracks how many connections each address holds and how fast it is opening them.
 *
 * Buckets are keyed by `normaliseIp`, which collapses an IPv6 address to its /64 — a single client
 * with a routed prefix would otherwise have effectively unlimited distinct addresses, making a
 * per-IP limit meaningless.
 */
export class ConnectionRegistry {
	readonly #countsByIp = new Map<string, number>()
	readonly #ratesByIp = new Map<string, TokenBucket>()
	#total = 0

	constructor(
		private readonly limits: ConnectionLimits,
		private readonly now: Clock = Date.now
	) {}

	get total(): number {
		return this.#total
	}

	countForIp(ip: string): number {
		return this.#countsByIp.get(normaliseIp(ip)) ?? 0
	}

	/**
	 * Decide whether to admit a connection, and account for it if so.
	 *
	 * The rate bucket is consumed *only* when the connection is otherwise admissible, so a client
	 * that is merely at its concurrent limit is not also punished with a rate-limit lockout it would
	 * have to wait out after disconnecting.
	 */
	admit(ip: string): AdmissionResult {
		const key = normaliseIp(ip)

		if (this.#total >= this.limits.maxTotal) return { ok: false, reason: 'server-full' }
		if ((this.#countsByIp.get(key) ?? 0) >= this.limits.maxPerIp) return { ok: false, reason: 'too-many-for-ip' }

		let bucket = this.#ratesByIp.get(key)
		if (!bucket) {
			bucket = new TokenBucket(this.limits.burstPerIp, this.limits.perIpPerMinute / 60, this.now)
			this.#ratesByIp.set(key, bucket)
		}
		if (!bucket.take()) return { ok: false, reason: 'connecting-too-fast' }

		this.#countsByIp.set(key, (this.#countsByIp.get(key) ?? 0) + 1)
		this.#total++
		return { ok: true }
	}

	release(ip: string): void {
		const key = normaliseIp(ip)
		const count = this.#countsByIp.get(key)
		if (count === undefined) return
		if (count <= 1) this.#countsByIp.delete(key)
		else this.#countsByIp.set(key, count - 1)
		this.#total = Math.max(0, this.#total - 1)
	}

	/**
	 * Drop rate buckets for addresses with no live connections and a full allowance.
	 *
	 * Without this the map grows once per distinct address seen, forever — a slow leak that a bored
	 * attacker can turn into a fast one.
	 */
	sweep(): number {
		let removed = 0
		for (const [key, bucket] of this.#ratesByIp) {
			if ((this.#countsByIp.get(key) ?? 0) === 0 && bucket.available >= bucket.capacity) {
				this.#ratesByIp.delete(key)
				removed++
			}
		}
		return removed
	}

	get trackedAddresses(): number {
		return this.#ratesByIp.size
	}
}

/**
 * Collapse an address to the unit a limit should apply to.
 *
 * IPv6 is bucketed by /64: that is the smallest block routinely assigned to a single subscriber, so
 * it is the granularity at which "one client" is meaningful. Per-address limits on IPv6 are theatre.
 */
export function normaliseIp(ip: string): string {
	// ::ffff:1.2.3.4 — an IPv4 address arriving on a dual-stack socket.
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
	if (mapped?.[1]) return mapped[1]

	if (!ip.includes(':')) return ip

	const expanded = expandIpv6(ip)
	if (!expanded) return ip
	return expanded.slice(0, 4).join(':') + '::/64'
}

function expandIpv6(ip: string): string[] | null {
	const withoutZone = ip.split('%')[0] ?? ip
	const parts = withoutZone.split('::')
	if (parts.length > 2) return null

	const head = parts[0] ? parts[0].split(':') : []
	const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : []
	if (parts.length === 1) {
		return head.length === 8 ? head : null
	}

	const fill = 8 - head.length - tail.length
	if (fill < 0) return null
	return [...head, ...Array(fill).fill('0'), ...tail]
}

/**
 * Resolve the client address, trusting exactly `trustedHops` proxies.
 *
 * X-Forwarded-For is appended to by each hop, so the trustworthy entry is `trustedHops` from the
 * right. Anything further left was supplied by the client and is forgeable — which is why
 * `trustedHops` defaults to 0 and must be set deliberately to match the deployment.
 */
export function resolveClientIp(
	socketAddress: string | undefined,
	forwardedFor: string | string[] | undefined,
	trustedHops: number
): string {
	const fallback = socketAddress ?? '0.0.0.0'
	if (trustedHops <= 0 || forwardedFor === undefined) return fallback

	const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor)
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
	if (chain.length === 0) return fallback

	// The socket address is itself the last hop, so index from the right of the header.
	const index = chain.length - trustedHops
	return chain[Math.max(0, index)] ?? fallback
}
