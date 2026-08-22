import {
	capabilitiesFor,
	KNOWN_API_VERSIONS,
	SUPPORTED_API_VERSION,
	type BitmapFormat,
	type SatelliteCapabilities,
} from '@satellite-mock/protocol'
import { ChaosConnection, DEFAULT_CHAOS, type ChaosConfig } from './chaos.js'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Config } from './config.js'
import { ConnectionRegistry, resolveClientIp } from './limits.js'
import { hashIp, type Logger } from './logging.js'
import { buildCommandHandlers } from './commands.js'
import { DeviceRegistry } from './devices.js'
import type { SatelliteEvents } from './events.js'
import { SatelliteSession } from './satelliteSession.js'
import { WebSocketConnection } from './transport/wsTransport.js'

export interface SatelliteServerOptions {
	config: Config
	logger: Logger
	events?: SatelliteEvents
	/** Companion exposes this as a user-config toggle, so it can be off on a version that has it. */
	subscriptionsEnabled?: boolean
}

/**
 * The satellite WebSocket listener.
 *
 * Note there is no Origin check here, and that is deliberate: native satellite clients are not
 * browsers and send no Origin header, so requiring one would break every real client. The web UI's
 * socket is a separate listener on a separate port, and that one does check. See docs/design.md §9.3.
 */
export class SatelliteServer {
	readonly #config: Config
	readonly #logger: Logger
	readonly #events: SatelliteEvents
	readonly #subscriptionsEnabled: boolean
	readonly #registry: ConnectionRegistry
	readonly #devices = new DeviceRegistry()
	readonly #sessions = new Set<SatelliteSession>()
	/** Lets the API reach a connection's chaos wrapper without threading it through every layer. */
	readonly #chaosByConnection = new WeakMap<SatelliteSession, ChaosConnection>()

	#http: Server | undefined
	#wss: WebSocketServer | undefined
	#liveness: NodeJS.Timeout | undefined
	#sweep: NodeJS.Timeout | undefined

	constructor(options: SatelliteServerOptions) {
		this.#config = options.config
		this.#logger = options.logger.child({ component: 'satellite' })
		this.#events = options.events ?? {}
		this.#subscriptionsEnabled = options.subscriptionsEnabled ?? true
		this.#registry = new ConnectionRegistry({
			maxTotal: options.config.MAX_CONNECTIONS_TOTAL,
			maxPerIp: options.config.MAX_CONNECTIONS_PER_IP,
			perIpPerMinute: options.config.CONNECTIONS_PER_IP_PER_MINUTE,
			burstPerIp: options.config.CONNECTION_BURST_PER_IP,
		})
	}

	get connectionCount(): number {
		return this.#sessions.size
	}

	get devices(): DeviceRegistry {
		return this.#devices
	}

	/** The chaos wrapper for a session, so the API can adjust it live. */
	chaosFor(session: SatelliteSession): ChaosConnection | undefined {
		return this.#chaosByConnection.get(session)
	}

	setChaos(session: SatelliteSession, config: ChaosConfig): boolean {
		const chaos = this.#chaosByConnection.get(session)
		if (!chaos) return false
		chaos.setConfig(config)
		return true
	}

	get address(): { port: number } | undefined {
		const addr = this.#http?.address()
		return addr && typeof addr === 'object' ? { port: addr.port } : undefined
	}

	async listen(): Promise<void> {
		const http = createServer((_req, res) => {
			// This listener speaks nothing but WebSocket. Anything else gets a flat 426 rather than a
			// helpful page, since it is the internet-facing port.
			res.writeHead(426, { 'Content-Type': 'text/plain' })
			res.end('Upgrade Required\n')
		})
		this.#http = http

		const wss = new WebSocketServer({
			server: http,
			path: '/ws/satellite',
			maxPayload: this.#config.MAX_FRAME_BYTES,
		})
		this.#wss = wss

		wss.on('connection', (socket, request) => {
			const ip = resolveClientIp(
				request.socket.remoteAddress,
				request.headers['x-forwarded-for'],
				this.#config.TRUSTED_PROXY_HOPS
			)

			const admission = this.#registry.admit(ip)
			if (!admission.ok) {
				this.#logger.warn({ ip: hashIp(ip), reason: admission.reason }, 'connection refused')
				// Close rather than terminate, so a legitimate client sees a clean close and can back
				// off, instead of an ambiguous socket error it will retry immediately.
				socket.close(1013, admission.reason)
				return
			}

			this.#onConnection(socket, request, ip)
		})

		wss.on('error', (error) => this.#logger.error({ err: error }, 'websocket server error'))

		await new Promise<void>((resolve, reject) => {
			http.once('error', reject)
			http.listen(this.#config.SATELLITE_PORT, this.#config.SATELLITE_BIND, () => {
				http.off('error', reject)
				resolve()
			})
		})

		this.#liveness = setInterval(() => this.#checkLiveness(), this.#config.IDLE_CHECK_INTERVAL_MS)
		this.#liveness.unref()
		this.#sweep = setInterval(() => this.#registry.sweep(), 60_000)
		this.#sweep.unref()

		this.#logger.info(
			{ port: this.address?.port ?? this.#config.SATELLITE_PORT, path: '/ws/satellite' },
			'satellite listener started'
		)
	}

	#onConnection(socket: WebSocket, request: IncomingMessage, ip: string): void {
		const raw = new WebSocketConnection(socket, ip, request)
		// Every connection goes through the chaos wrapper, configured to do nothing until someone
		// turns a knob on. Wrapping unconditionally keeps one code path rather than two.
		const connection = new ChaosConnection(raw, DEFAULT_CHAOS)
		const logger = this.#logger.child({ connection: raw.id, ip: hashIp(ip) })

		const profile = this.#capabilitiesFor(request)
		const session = new SatelliteSession({
			connection,
			config: this.#config,
			logger,
			devices: this.#devices,
			events: this.#events,
			capabilities: profile.capabilities,
			subscriptionsEnabled: profile.subscriptionsEnabled,
			bitmapFormats: profile.bitmapFormats,
			// Built per connection because the command set depends on the advertised version: an
			// older profile must answer `Unknown command` for a command it predates, exactly as a
			// server of that vintage would.
			handlers: buildCommandHandlers(profile.capabilities),
		})
		this.#chaosByConnection.set(session, connection)
		this.#sessions.add(session)
		this.#events.onConnectionOpen?.(session)
		logger.info({ total: this.#sessions.size }, 'connection opened')

		// Teardown is anchored on 'close', which node guarantees fires exactly once, and is registered
		// before anything that could throw — otherwise a failed handshake would leak the registry slot.
		socket.on('close', () => {
			raw.markClosed()
			const removed = session.cleanup()
			this.#events.onConnectionClose?.(session)
			this.#sessions.delete(session)
			this.#registry.release(ip)
			logger.info(
				{ total: this.#sessions.size, devices: removed.length, bytesIn: raw.bytesReceived },
				'connection closed'
			)
		})
		socket.on('error', (error) => logger.debug({ err: error }, 'socket error'))

		socket.on('message', (data) => {
			const text = typeof data === 'string' ? data : data.toString()
			raw.countReceived(Buffer.byteLength(text))
			session.receive(text)
		})

		try {
			session.sendHandshake()
		} catch (error) {
			logger.error({ err: error }, 'handshake failed')
			session.close()
		}
	}

	/**
	 * Resolve the advertised capabilities from the connection URL.
	 *
	 * This has to come from the URL, and that is a correction to the original design, which called
	 * for a per-device override applied on the next connect. It cannot work: `BEGIN` and `CAPS` are
	 * sent the moment the socket opens, long before any `ADD-DEVICE`, so the server has no device
	 * identity at the point it must choose a version. The connection URL is the only thing it knows.
	 *
	 * Everything here is validated against a known list, so there is nothing to inject.
	 */
	#capabilitiesFor(request: IncomingMessage): {
		capabilities: SatelliteCapabilities
		subscriptionsEnabled: boolean
		bitmapFormats: readonly BitmapFormat[] | undefined
	} {
		const url = new URL(request.url ?? '/', 'http://localhost')

		const requested = url.searchParams.get('api')
		const version = KNOWN_API_VERSIONS.some((entry) => entry.version === requested)
			? requested!
			: SUPPORTED_API_VERSION
		const capabilities = capabilitiesFor(version)

		const subscriptionsEnabled = url.searchParams.get('subs') !== '0' && this.#subscriptionsEnabled

		const formatsParam = url.searchParams.get('formats')
		const bitmapFormats = formatsParam
			? (formatsParam
					.split(',')
					.filter((format): format is BitmapFormat =>
						(capabilities.bitmapFormats as readonly string[]).includes(format)
					) as readonly BitmapFormat[])
			: undefined

		return {
			capabilities,
			subscriptionsEnabled,
			// An empty or entirely-unknown list would advertise nothing; fall back rather than lie.
			bitmapFormats: bitmapFormats && bitmapFormats.length > 0 ? bitmapFormats : undefined,
		}
	}

	#checkLiveness(): void {
		for (const session of this.#sessions) {
			if (session.isIdle()) {
				this.#logger.debug({ connection: session.connection.id }, 'idle timeout')
				session.close()
			} else if (session.isExpired()) {
				this.#logger.info({ connection: session.connection.id }, 'connection lifetime exceeded')
				session.close()
			}
		}
	}

	async close(): Promise<void> {
		if (this.#liveness) clearInterval(this.#liveness)
		if (this.#sweep) clearInterval(this.#sweep)

		for (const session of this.#sessions) session.close()
		this.#sessions.clear()

		await new Promise<void>((resolve) => {
			if (!this.#wss) return resolve()
			this.#wss.close(() => resolve())
		})
		await new Promise<void>((resolve) => {
			if (!this.#http) return resolve()
			this.#http.close(() => resolve())
		})
		this.#wss = undefined
		this.#http = undefined
	}
}
