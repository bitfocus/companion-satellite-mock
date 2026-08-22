import { z } from 'zod'
import type { SatelliteConnection } from './transport/types.js'

/**
 * Fault injection.
 *
 * Every knob has a hard ceiling, and every one is scoped to a single claimed session — a tool that
 * can be pointed at someone else's connection, or turned up without limit, is an amplifier rather
 * than a test tool. See docs/design.md §8.3.
 */
export const ChaosConfigSchema = z.object({
	/** Fixed delay added to every outbound line. */
	latencyMs: z.number().int().min(0).max(2000).default(0),
	/** Extra random delay on top, uniform in [0, jitterMs]. */
	jitterMs: z.number().int().min(0).max(2000).default(0),
	/** Fraction of outbound lines silently dropped. */
	dropRate: z.number().min(0).max(1).default(0),
	/** Fraction of outbound lines sent twice. */
	duplicateRate: z.number().min(0).max(1).default(0),
	/**
	 * Split each outbound line across this many frames.
	 *
	 * The highest-value tool here. A client that assumes one WebSocket frame is one message passes
	 * every ordinary test and fails in production, because Companion's own writes happen to be one
	 * line per frame. 0 disables; 1 is a no-op; large values approach one byte per frame.
	 */
	splitFrames: z.number().int().min(0).max(64).default(0),
	/** Buffer outbound lines and flush them together, the opposite failure mode to splitting. */
	coalesceMs: z.number().int().min(0).max(2000).default(0),
	/** Stop answering PING. The client should notice and reconnect. */
	swallowPings: z.boolean().default(false),
	/** Emit Companion's trailing space before the newline, or not. */
	trailingSpace: z.boolean().default(true),
	/** Terminate lines with CRLF instead of LF. */
	crlf: z.boolean().default(false),
})

export type ChaosConfig = z.infer<typeof ChaosConfigSchema>

export const DEFAULT_CHAOS: ChaosConfig = ChaosConfigSchema.parse({})

export const isChaosActive = (config: ChaosConfig): boolean =>
	config.latencyMs > 0 ||
	config.jitterMs > 0 ||
	config.dropRate > 0 ||
	config.duplicateRate > 0 ||
	config.splitFrames > 1 ||
	config.coalesceMs > 0 ||
	config.swallowPings ||
	!config.trailingSpace ||
	config.crlf

export interface ChaosStats {
	sent: number
	dropped: number
	duplicated: number
	split: number
}

/**
 * Wraps a connection and misbehaves on the way out.
 *
 * Deliberately a wrapper rather than a flag inside the emitter: everything above it — scenarios,
 * commands, the handshake — stays unaware that anything unusual is happening, which is the only way
 * to be sure the chaos is testing the *client* rather than accidentally exercising a different code
 * path on the server.
 */
export class ChaosConnection implements SatelliteConnection {
	#config: ChaosConfig
	#coalesceBuffer: string[] = []
	#coalesceTimer: NodeJS.Timeout | undefined
	#stats: ChaosStats = { sent: 0, dropped: 0, duplicated: 0, split: 0 }

	constructor(
		private readonly inner: SatelliteConnection,
		config: ChaosConfig = DEFAULT_CHAOS,
		private readonly random: () => number = Math.random
	) {
		this.#config = config
	}

	get config(): ChaosConfig {
		return this.#config
	}

	setConfig(config: ChaosConfig): void {
		this.#config = config
		if (config.coalesceMs === 0) this.#flushCoalesced()
	}

	get stats(): ChaosStats {
		return { ...this.#stats }
	}

	get id(): string {
		return this.inner.id
	}
	get kind(): 'ws' | 'tcp' {
		return this.inner.kind
	}
	get remoteAddress(): string {
		return this.inner.remoteAddress
	}
	get bytesReceived(): number {
		return this.inner.bytesReceived
	}
	get bytesSent(): number {
		return this.inner.bytesSent
	}
	get messagesReceived(): number {
		return this.inner.messagesReceived
	}
	get messagesSent(): number {
		return this.inner.messagesSent
	}
	get openedAt(): number {
		return this.inner.openedAt
	}
	get closed(): boolean {
		return this.inner.closed
	}
	get bufferedAmount(): number {
		return (this.inner as { bufferedAmount?: number }).bufferedAmount ?? 0
	}

	get swallowPings(): boolean {
		return this.#config.swallowPings
	}

	send(line: string): void {
		if (this.closed) return

		const rewritten = this.#rewriteTerminator(line)

		if (this.#config.dropRate > 0 && this.random() < this.#config.dropRate) {
			this.#stats.dropped++
			return
		}

		const copies = this.#config.duplicateRate > 0 && this.random() < this.#config.duplicateRate ? 2 : 1
		if (copies > 1) this.#stats.duplicated++

		for (let i = 0; i < copies; i++) this.#dispatch(rewritten)
	}

	/** Apply the terminator knobs. Upstream always emits `" \n"`; both halves are togglable. */
	#rewriteTerminator(line: string): string {
		let body = line.replace(/\r?\n$/, '')
		if (!this.#config.trailingSpace) body = body.replace(/ +$/, '')
		return body + (this.#config.crlf ? '\r\n' : '\n')
	}

	#dispatch(line: string): void {
		const delay = this.#config.latencyMs + (this.#config.jitterMs > 0 ? this.random() * this.#config.jitterMs : 0)

		if (this.#config.coalesceMs > 0) {
			this.#coalesceBuffer.push(line)
			this.#coalesceTimer ??= setTimeout(() => this.#flushCoalesced(), this.#config.coalesceMs)
			return
		}

		if (delay > 0) {
			const timer = setTimeout(() => this.#write(line), delay)
			// Never hold the process open for an injected delay.
			timer.unref?.()
			return
		}

		this.#write(line)
	}

	#flushCoalesced(): void {
		if (this.#coalesceTimer) clearTimeout(this.#coalesceTimer)
		this.#coalesceTimer = undefined
		if (this.#coalesceBuffer.length === 0) return

		const batch = this.#coalesceBuffer.join('')
		this.#coalesceBuffer = []
		this.inner.send(batch)
		this.#stats.sent++
	}

	#write(line: string): void {
		if (this.closed) return

		const pieces = this.#config.splitFrames
		if (pieces > 1) {
			const size = Math.max(1, Math.ceil(line.length / pieces))
			for (let offset = 0; offset < line.length; offset += size) {
				this.inner.send(line.slice(offset, offset + size))
			}
			this.#stats.split++
			this.#stats.sent++
			return
		}

		this.inner.send(line)
		this.#stats.sent++
	}

	destroy(): void {
		if (this.#coalesceTimer) clearTimeout(this.#coalesceTimer)
		this.inner.destroy()
	}
}
