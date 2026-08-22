/**
 * The transport abstraction.
 *
 * Only WebSocket is implemented, but everything above this interface is written against it so that
 * adding TCP later is a new file rather than a refactor. It mirrors Companion's
 * `SatelliteSocketWrapper` so the two stay comparable.
 */
export interface SatelliteConnection {
	readonly id: string
	readonly kind: 'ws' | 'tcp'
	/** The resolved client address, already accounting for trusted proxy hops. */
	readonly remoteAddress: string
	/** Bytes are counted for metrics and for the per-connection rate limit. */
	readonly bytesReceived: number
	readonly bytesSent: number
	readonly messagesReceived: number
	readonly messagesSent: number
	readonly openedAt: number

	/**
	 * Whether inbound PINGs should go unanswered.
	 *
	 * Lives on the connection because that is where the chaos wrapper is; the session consults it
	 * rather than owning it, so the protocol layer stays unaware fault injection exists.
	 */
	readonly swallowPings?: boolean

	/** Send one already-serialised line, terminator included. */
	send(line: string): void
	/** Close hard, the equivalent of Companion's `destroy()`. */
	destroy(): void
	/**
	 * Close gracefully with a specific status code, where the transport has such a concept.
	 *
	 * Which code a client receives changes what a well-written one does next — 1001 "going away"
	 * invites an immediate reconnect, 1013 "try again later" asks for a backoff, 1008 says stop —
	 * and getting that wrong is invisible under `destroy()`, which delivers no code at all.
	 * Optional: TCP has nothing to map it onto and will fall back to `destroy()`.
	 */
	closeWith?(code: number, reason?: string): void
	readonly closed: boolean
}

export interface ConnectionHandlers {
	onLine: (line: string) => void
	onOverflow: () => void
	onClose: () => void
}
