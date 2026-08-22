/**
 * A bounded LRU keyed by string, sized by both entry count and total bytes.
 *
 * Both bounds matter: 512 tiny buttons and four 512px ones have wildly different memory costs for
 * the same entry count, and this runs under a hard container memory limit.
 */
export class LruCache<T> {
	readonly #entries = new Map<string, { value: T; bytes: number }>()
	#bytes = 0
	#hits = 0
	#misses = 0

	constructor(
		private readonly maxEntries: number,
		private readonly maxBytes: number
	) {}

	get(key: string): T | undefined {
		const entry = this.#entries.get(key)
		if (!entry) {
			this.#misses++
			return undefined
		}
		this.#hits++
		// Re-insert to move it to the end. Map preserves insertion order, so the first key is always
		// the least recently used and eviction needs no extra bookkeeping.
		this.#entries.delete(key)
		this.#entries.set(key, entry)
		return entry.value
	}

	set(key: string, value: T, bytes: number): void {
		const existing = this.#entries.get(key)
		if (existing) {
			this.#bytes -= existing.bytes
			this.#entries.delete(key)
		}

		this.#entries.set(key, { value, bytes })
		this.#bytes += bytes

		while (this.#entries.size > this.maxEntries || this.#bytes > this.maxBytes) {
			const oldest = this.#entries.keys().next()
			if (oldest.done) break
			const evicted = this.#entries.get(oldest.value)
			this.#entries.delete(oldest.value)
			if (evicted) this.#bytes -= evicted.bytes
		}
	}

	get stats(): { entries: number; bytes: number; hits: number; misses: number; hitRate: number } {
		const total = this.#hits + this.#misses
		return {
			entries: this.#entries.size,
			bytes: this.#bytes,
			hits: this.#hits,
			misses: this.#misses,
			hitRate: total === 0 ? 0 : this.#hits / total,
		}
	}

	clear(): void {
		this.#entries.clear()
		this.#bytes = 0
	}
}
