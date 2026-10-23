import { createServer, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'
import type { Config } from './config.js'
import type { Logger } from './logging.js'
import type { MockRuntime } from './runtime.js'
import type { SatelliteServer } from './satelliteServer.js'

/**
 * Prometheus metrics, on their own listener.
 *
 * Two independent defences, because one mistyped proxy rule should not expose operational internals:
 * the listener binds to loopback by default and the reverse proxy has no route to it at all, and an
 * optional bearer token gates it as well. An unauthenticated request answers **404**, not 401, so a
 * prober cannot confirm the endpoint exists. See docs/security.md.
 */
export class MetricsServer {
	readonly registry = new Registry()

	readonly connections: Gauge<'transport'>
	readonly connectionsTotal: Counter<'transport'>
	readonly sessions: Gauge<'state'>
	readonly messages: Counter<'direction' | 'command'>
	readonly bytes: Counter<'direction'>
	readonly renderDuration: Histogram<'format'>
	readonly renderCache: Counter<'result'>
	readonly rateLimitRejections: Counter<'limit'>
	readonly claimAttempts: Counter<'result'>

	readonly #config: Config
	readonly #logger: Logger
	#http: Server | undefined

	constructor(config: Config, logger: Logger) {
		this.#config = config
		this.#logger = logger.child({ component: 'metrics' })

		collectDefaultMetrics({ register: this.registry })

		const registers = [this.registry]
		this.connections = new Gauge({
			name: 'satellite_connections',
			help: 'Open satellite connections',
			labelNames: ['transport'],
			registers,
		})
		this.connectionsTotal = new Counter({
			name: 'satellite_connections_total',
			help: 'Satellite connections opened',
			labelNames: ['transport'],
			registers,
		})
		this.sessions = new Gauge({
			name: 'satellite_sessions',
			help: 'Sessions by state',
			labelNames: ['state'],
			registers,
		})
		this.messages = new Counter({
			name: 'satellite_messages_total',
			help: 'Protocol messages',
			labelNames: ['direction', 'command'],
			registers,
		})
		this.bytes = new Counter({
			name: 'satellite_bytes_total',
			help: 'Protocol bytes',
			labelNames: ['direction'],
			registers,
		})
		this.renderDuration = new Histogram({
			name: 'satellite_render_duration_seconds',
			help: 'Button render time',
			labelNames: ['format'],
			buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.05],
			registers,
		})
		this.renderCache = new Counter({
			name: 'satellite_render_cache_total',
			help: 'Render cache hits and misses',
			labelNames: ['result'],
			registers,
		})
		this.rateLimitRejections = new Counter({
			name: 'satellite_rate_limit_rejections_total',
			help: 'Requests refused by a limit',
			labelNames: ['limit'],
			registers,
		})
		this.claimAttempts = new Counter({
			name: 'satellite_claim_attempts_total',
			help: 'Claim code attempts',
			labelNames: ['result'],
			registers,
		})
	}

	/** Refresh the gauges that are derived rather than incremented. */
	sample(satellite: SatelliteServer, runtime: MockRuntime): void {
		this.connections.set({ transport: 'ws' }, satellite.connectionCount)

		const counts = { unclaimed: 0, claimed: 0, offline: 0 }
		for (const session of runtime.sessions.all()) counts[session.state]++
		for (const [state, value] of Object.entries(counts)) this.sessions.set({ state }, value)

		const cache = runtime.renderer.cacheStats
		this.renderCache.reset()
		this.renderCache.inc({ result: 'hit' }, cache.hits)
		this.renderCache.inc({ result: 'miss' }, cache.misses)
	}

	get address(): { port: number } | undefined {
		const addr = this.#http?.address()
		return addr && typeof addr === 'object' ? { port: addr.port } : undefined
	}

	async listen(onScrape?: () => void): Promise<void> {
		const http = createServer((req, res) => {
			if (req.url !== '/metrics' || !this.#authorised(req.headers.authorization)) {
				res.writeHead(404, { 'Content-Type': 'text/plain' })
				res.end('Not Found\n')
				return
			}

			onScrape?.()
			this.registry
				.metrics()
				.then((body) => {
					res.writeHead(200, { 'Content-Type': this.registry.contentType })
					res.end(body)
				})
				.catch((error: unknown) => {
					this.#logger.error({ err: error }, 'failed to collect metrics')
					res.writeHead(500).end()
				})
		})
		this.#http = http

		await new Promise<void>((resolve, reject) => {
			http.once('error', reject)
			http.listen(this.#config.METRICS_PORT, this.#config.METRICS_BIND, () => {
				http.off('error', reject)
				resolve()
			})
		})

		this.#logger.info(
			{ bind: this.#config.METRICS_BIND, port: this.address?.port, tokenRequired: !!this.#config.METRICS_TOKEN },
			'metrics listener started'
		)
	}

	#authorised(header: string | undefined): boolean {
		const token = this.#config.METRICS_TOKEN
		if (!token) return true
		if (!header?.startsWith('Bearer ')) return false

		const provided = Buffer.from(header.slice('Bearer '.length))
		const expected = Buffer.from(token)
		if (provided.length !== expected.length) return false
		return timingSafeEqual(provided, expected)
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve) => {
			if (!this.#http) return resolve()
			this.#http.close(() => resolve())
		})
		this.#http = undefined
	}
}
