import {
	buildBegin,
	buildCaps,
	buildPong,
	capabilitiesFor,
	ERRORS,
	normaliseLine,
	parseLineParameters,
	serialiseError,
	serialiseMessage,
	splitCommand,
	SUPPORTED_API_VERSION,
	unknownCommandError,
	type BitmapFormat,
	type ParsedParams,
	type SatelliteCapabilities,
} from '@satellite-mock/protocol'
import type { Config } from './config.js'
import type { Logger } from './logging.js'
import { truncate } from './logging.js'
import { TokenBucket } from './limits.js'
import { LineBuffer } from './transport/lineBuffer.js'
import type { SatelliteConnection } from './transport/types.js'
import type { Device, DeviceRegistry } from './devices.js'
import type { SatelliteEvents, Subscription } from './events.js'

/** A handler for one protocol command. Phase 3 registers the device commands here. */
export type CommandHandler = (context: CommandContext) => void

export interface CommandContext {
	session: SatelliteSession
	command: string
	/** The unparsed remainder of the line — `PING` needs it raw. */
	body: string
	params: ParsedParams
}

export interface SatelliteSessionOptions {
	connection: SatelliteConnection
	config: Config
	logger: Logger
	capabilities?: SatelliteCapabilities
	/** Lets the operator disable subscriptions on a version that supports them, as Companion does. */
	subscriptionsEnabled?: boolean
	/** Narrow what CAPS advertises, to exercise a client's bitmap-format fallback. */
	bitmapFormats?: readonly BitmapFormat[] | undefined
	handlers?: Map<string, CommandHandler>
	/** Server-wide, because device ids are global in Companion — see DeviceRegistry. */
	devices: DeviceRegistry
	events?: SatelliteEvents
	now?: () => number
}

/**
 * Per-connection protocol state: the handshake, line framing, liveness and rate limiting.
 *
 * Deliberately knows nothing about devices or sessions-in-the-UI sense — Phase 3 layers those on by
 * registering command handlers, which keeps this file about the wire and only the wire.
 */
export class SatelliteSession {
	readonly connection: SatelliteConnection
	readonly capabilities: SatelliteCapabilities
	readonly devices: DeviceRegistry
	readonly events: SatelliteEvents
	/** Subscriptions are per-connection, not per-device — they exist without any surface at all. */
	readonly subscriptions = new Map<string, Subscription>()

	readonly #config: Config
	readonly #logger: Logger
	readonly #buffer: LineBuffer
	readonly #messageBucket: TokenBucket
	readonly #byteBucket: TokenBucket
	readonly #handlers: Map<string, CommandHandler>
	readonly #now: () => number

	#lastReceivedAt: number
	#closed = false

	constructor(options: SatelliteSessionOptions) {
		this.connection = options.connection
		this.devices = options.devices
		this.events = options.events ?? {}
		this.#config = options.config
		this.#logger = options.logger
		this.#now = options.now ?? Date.now
		this.capabilities = options.capabilities ?? capabilitiesFor(SUPPORTED_API_VERSION)
		this.#handlers = options.handlers ?? new Map()
		this.#buffer = new LineBuffer(options.config.MAX_LINE_BYTES)
		this.#lastReceivedAt = this.#now()

		this.#messageBucket = new TokenBucket(
			options.config.MAX_MESSAGES_PER_SECOND,
			options.config.MAX_MESSAGES_PER_SECOND,
			this.#now
		)
		this.#byteBucket = new TokenBucket(
			options.config.MAX_BYTES_PER_SECOND,
			options.config.MAX_BYTES_PER_SECOND,
			this.#now
		)

		this.#subscriptionsEnabled = options.subscriptionsEnabled ?? true
		this.#bitmapFormats = options.bitmapFormats
	}

	readonly #bitmapFormats: readonly BitmapFormat[] | undefined

	readonly #subscriptionsEnabled: boolean

	/**
	 * Whether subscription commands should work right now.
	 *
	 * Two separate conditions, and the distinction matters: the API version decides whether the
	 * feature *exists*, and the operator toggle decides whether it is *enabled* — which is exactly
	 * the split `CAPS` exists to express.
	 */
	get subscriptionsAvailable(): boolean {
		return this.capabilities.subscriptions && this.#subscriptionsEnabled
	}

	/** Drop every device this connection registered. Called once, on close. */
	cleanup(): Device[] {
		const removed = this.devices.removeAllFor(this.connection)
		for (const device of removed) this.events.onDeviceRemoved?.(this, device)
		this.subscriptions.clear()
		return removed
	}

	/** Send a line and record it in the trace. All outbound traffic goes through here. */
	send(line: string): void {
		this.connection.send(line)
		this.events.onLine?.(this, 'out', line)
	}

	/** Send `BEGIN`, and `CAPS` if the advertised version is new enough to have it. */
	sendHandshake(): void {
		const handshake = {
			companionVersion: this.#config.COMPANION_VERSION,
			subscriptionsEnabled: this.#subscriptionsEnabled,
			...(this.#bitmapFormats ? { bitmapFormats: this.#bitmapFormats } : {}),
		}
		this.send(buildBegin(this.capabilities, handshake))
		const caps = buildCaps(this.capabilities, handshake)
		if (caps) this.send(caps)
	}

	get lastReceivedAt(): number {
		return this.#lastReceivedAt
	}

	/** True once the connection has been idle past the configured timeout. */
	isIdle(): boolean {
		return this.#lastReceivedAt < this.#now() - this.#config.IDLE_TIMEOUT_MS
	}

	isExpired(): boolean {
		return this.connection.openedAt < this.#now() - this.#config.MAX_CONNECTION_LIFETIME_MS
	}

	/**
	 * Feed an inbound chunk.
	 *
	 * Rate limiting happens here, before parsing, so a flood costs a bucket check rather than a
	 * parse. Note the reference client pings at 10 Hz, so the defaults have to accommodate a
	 * genuinely chatty client — see docs/protocol.md §4.
	 */
	receive(chunk: string): void {
		if (this.#closed) return

		this.#lastReceivedAt = this.#now()

		const bytes = Buffer.byteLength(chunk)
		if (!this.#byteBucket.take(bytes) || !this.#messageBucket.take()) {
			this.#logger.warn({ bytes }, 'rate limit exceeded, closing connection')
			this.#sendError('ERROR', 'Rate limit exceeded')
			this.close()
			return
		}

		const { lines, overflow } = this.#buffer.push(chunk)
		for (const line of lines) {
			const normalised = normaliseLine(line)
			this.events.onLine?.(this, 'in', normalised)
			this.#handleLine(normalised)
			if (this.#closed) return
		}

		if (overflow) {
			this.#logger.warn({ limit: this.#config.MAX_LINE_BYTES }, 'line too long, closing connection')
			// Reproduces upstream's doubled token: message name ERROR *and* status ERROR.
			this.#sendError('ERROR', ERRORS.lineTooLong)
			this.close()
		}
	}

	#handleLine(line: string): void {
		const { command, body } = splitCommand(line)
		const upper = command.toUpperCase()

		// Skip the parse for PING: its payload is the raw remainder, and it is by far the most
		// frequent message on the wire.
		if (upper === 'PING') {
			// Deliberately unanswered when the chaos tool asks for it. A client should notice the
			// silence and reconnect; one that does not will sit on a dead socket forever.
			if (!this.connection.swallowPings) this.send(buildPong(body))
			return
		}
		if (upper === 'PONG') return
		if (upper === 'QUIT') {
			this.close()
			return
		}

		const handler = this.#handlers.get(upper)
		if (!handler) {
			this.#logger.debug({ line: truncate(line) }, 'unknown command')
			// `ERROR MESSAGE="…"` — no status token. Distinct from the doubled-ERROR line-too-long
			// case below, which upstream emits with both a message name and a status of ERROR.
			this.send(serialiseMessage('ERROR', null, null, { MESSAGE: unknownCommandError(upper) }))
			return
		}

		try {
			handler({ session: this, command: upper, body, params: parseLineParameters(body) })
		} catch (error) {
			this.#logger.error({ err: error, command: upper }, 'error handling command')
		}
	}

	#sendError(messageName: string, message: string): void {
		this.send(serialiseError(messageName, null, message))
	}

	close(): void {
		if (this.#closed) return
		this.#closed = true
		this.connection.destroy()
	}

	get closed(): boolean {
		return this.#closed
	}
}
