import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'
import { applyWSSHandler } from '@trpc/server/adapters/ws'
import type { Config } from '../config.js'
import type { Logger } from '../logging.js'
import type { MockRuntime } from '../runtime.js'
import { appRouter, type TrpcContext } from './trpc.js'

export interface WebServerOptions {
	config: Config
	logger: Logger
	runtime: MockRuntime
	/** Where the built UI lives. Omitted in tests, which only exercise the API. */
	staticDir?: string
}

/**
 * The web UI and its tRPC socket.
 *
 * Separate from the satellite listener on purpose: this one *does* check `Origin`, because browsers
 * send it and a cross-origin page driving someone's session is a real (if minor) nuisance. The
 * satellite listener must not check it, since native clients send none. Same reason they are on
 * different ports — one set of guards would be wrong for one of them.
 */
export class WebServer {
	readonly #config: Config
	readonly #logger: Logger
	readonly #runtime: MockRuntime
	readonly #staticDir: string | undefined

	#http: Server | undefined
	#wss: WebSocketServer | undefined
	#handler: { broadcastReconnectNotification: () => void } | undefined

	constructor(options: WebServerOptions) {
		this.#config = options.config
		this.#logger = options.logger.child({ component: 'web' })
		this.#runtime = options.runtime
		this.#staticDir = options.staticDir ?? defaultStaticDir()
	}

	get address(): { port: number } | undefined {
		const addr = this.#http?.address()
		return addr && typeof addr === 'object' ? { port: addr.port } : undefined
	}

	async listen(): Promise<void> {
		const app = express()

		app.disable('x-powered-by')
		app.use(express.json({ limit: '64kb' }))

		app.use((_req, res, next) => {
			// A strict CSP: the UI is entirely self-contained, and the only remote thing it loads is
			// nothing at all. `img-src data:` is needed for the button previews.
			res.setHeader(
				'Content-Security-Policy',
				"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
			)
			res.setHeader('X-Content-Type-Options', 'nosniff')
			res.setHeader('Referrer-Policy', 'no-referrer')
			res.setHeader('X-Frame-Options', 'DENY')
			next()
		})

		app.get('/healthz', (_req, res) => {
			res.json({ ok: true, sessions: this.#runtime.sessions.size })
		})

		if (this.#staticDir && existsSync(this.#staticDir)) {
			app.use(express.static(this.#staticDir, { maxAge: '1h', index: 'index.html' }))
			// SPA fallback, but never for the API or health paths.
			app.get(/^(?!\/(healthz|ws)).*/, (_req, res) => {
				res.sendFile('index.html', { root: this.#staticDir })
			})
		}

		const http = createServer(app)
		this.#http = http

		const wss = new WebSocketServer({ noServer: true })
		this.#wss = wss

		http.on('upgrade', (request, socket, head) => {
			if (!request.url?.startsWith('/ws/trpc')) {
				socket.destroy()
				return
			}
			if (!this.#originAllowed(request.headers.origin)) {
				this.#logger.warn({ origin: request.headers.origin }, 'rejected ws upgrade from disallowed origin')
				socket.destroy()
				return
			}
			wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
		})

		this.#handler = applyWSSHandler({
			wss,
			router: appRouter,
			createContext: ({ req }): TrpcContext => {
				const url = new URL(req.url ?? '/', 'http://localhost')
				const uiClientId = url.searchParams.get('client') ?? 'anonymous'
				return { runtime: this.#runtime, uiClientId: uiClientId.slice(0, 64) }
			},
		})

		await new Promise<void>((resolve, reject) => {
			http.once('error', reject)
			http.listen(this.#config.WEB_PORT, this.#config.WEB_BIND, () => {
				http.off('error', reject)
				resolve()
			})
		})

		this.#logger.info({ port: this.address?.port ?? this.#config.WEB_PORT }, 'web listener started')
	}

	/**
	 * Same-origin only, when a public origin is configured.
	 *
	 * With none configured (development), anything is allowed — otherwise `vite dev` on another port
	 * could not talk to it, and a developer would disable the check permanently to get work done.
	 */
	#originAllowed(origin: string | undefined): boolean {
		const expected = this.#config.PUBLIC_ORIGIN
		if (!expected) return true
		if (!origin) return false
		return origin === expected
	}

	async close(): Promise<void> {
		this.#handler?.broadcastReconnectNotification()
		await new Promise<void>((resolve) => {
			if (!this.#wss) return resolve()
			for (const client of this.#wss.clients) client.terminate()
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

function defaultStaticDir(): string | undefined {
	try {
		return fileURLToPath(new URL('../../../webui/dist', import.meta.url))
	} catch {
		return undefined
	}
}
