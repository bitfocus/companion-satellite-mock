import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import type { SatelliteConnection } from './types.js'

/** How long a peer gets to answer a close frame before the socket is terminated anyway. */
const CLOSE_GRACE_MS = 2000

/**
 * A `SatelliteConnection` over a WebSocket.
 *
 * Deliberately thin: buffering, dispatch and limits all live above it, so the eventual TCP
 * implementation shares every one of them.
 */
export class WebSocketConnection implements SatelliteConnection {
	readonly id = randomUUID()
	readonly kind = 'ws' as const
	readonly openedAt = Date.now()

	#bytesReceived = 0
	#bytesSent = 0
	#messagesReceived = 0
	#messagesSent = 0
	#closed = false

	constructor(
		private readonly socket: WebSocket,
		readonly remoteAddress: string,
		readonly request: IncomingMessage
	) {}

	get bytesReceived(): number {
		return this.#bytesReceived
	}
	get bytesSent(): number {
		return this.#bytesSent
	}
	get messagesReceived(): number {
		return this.#messagesReceived
	}
	get messagesSent(): number {
		return this.#messagesSent
	}
	get closed(): boolean {
		return this.#closed
	}

	/** Called by the owner for each inbound frame, so accounting lives in one place. */
	countReceived(bytes: number): void {
		this.#bytesReceived += bytes
		this.#messagesReceived++
	}

	send(line: string): void {
		if (this.#closed) return
		this.#bytesSent += Buffer.byteLength(line)
		this.#messagesSent++
		this.socket.send(line)
	}

	/** How much the socket has queued but not yet flushed — the backpressure signal. */
	get bufferedAmount(): number {
		return this.socket.bufferedAmount
	}

	destroy(): void {
		if (this.#closed) return
		this.#closed = true
		// terminate() rather than close(): a peer that never sends its own close frame would
		// otherwise linger, and this must be the hard-kill path the chaos tools rely on.
		this.socket.terminate()
	}

	/**
	 * Close with a status code the client can actually read, then hard-kill if it does not answer.
	 *
	 * `close()` alone is not enough: a peer that never returns its own close frame would leave the
	 * socket half-open indefinitely, so the terminate is the backstop. Marking closed immediately
	 * stops anything further being written into a socket that is on its way out.
	 */
	closeWith(code: number, reason?: string): void {
		if (this.#closed) return
		this.#closed = true

		try {
			this.socket.close(code, reason)
		} catch {
			this.socket.terminate()
			return
		}

		const timer = setTimeout(() => this.socket.terminate(), CLOSE_GRACE_MS)
		timer.unref?.()
	}

	markClosed(): void {
		this.#closed = true
	}
}
