import { createServer, type IncomingMessage, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Config } from './config.js'
import { ConnectionRegistry, resolveClientIp } from './limits.js'
import { hashIp, type Logger } from './logging.js'
import { SatelliteSession, type CommandHandler } from './satelliteSession.js'
import { WebSocketConnection } from './transport/wsTransport.js'

export interface SatelliteServerOptions {
	config: Config
	logger: Logger
	handlers?: Map<string, CommandHandler>
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
	readonly #handlers: Map<string, CommandHandler>
	readonly #registry: ConnectionRegistry
	readonly #sessions = new Set<SatelliteSession>()

	#http: Server | undefined
	#wss: WebSocketServer | undefined
	#liveness: NodeJS.Timeout | undefined
	#sweep: NodeJS.Timeout | undefined

	constructor(options: SatelliteServerOptions) {
		this.#config = options.config
		this.#logger = options.logger.child({ component: 'satellite' })
		this.#handlers = options.handlers ?? new Map()
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
		const connection = new WebSocketConnection(socket, ip, request)
		const logger = this.#logger.child({ connection: connection.id, ip: hashIp(ip) })
		const session = new SatelliteSession({
			connection,
			config: this.#config,
			logger,
			handlers: this.#handlers,
		})
		this.#sessions.add(session)
		logger.info({ total: this.#sessions.size }, 'connection opened')

		// Teardown is anchored on 'close', which node guarantees fires exactly once, and is registered
		// before anything that could throw — otherwise a failed handshake would leak the registry slot.
		socket.on('close', () => {
			connection.markClosed()
			this.#sessions.delete(session)
			this.#registry.release(ip)
			logger.info({ total: this.#sessions.size, bytesIn: connection.bytesReceived }, 'connection closed')
		})
		socket.on('error', (error) => logger.debug({ err: error }, 'socket error'))

		socket.on('message', (data) => {
			const text = typeof data === 'string' ? data : data.toString()
			connection.countReceived(Buffer.byteLength(text))
			session.receive(text)
		})

		try {
			session.sendHandshake()
		} catch (error) {
			logger.error({ err: error }, 'handshake failed')
			session.close()
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
