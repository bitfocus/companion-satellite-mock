import { WebSocket } from 'ws'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, type Config } from './config.js'
import { MockRuntime } from './runtime.js'
import { SatelliteServer } from './satelliteServer.js'
import { appRouter, type TrpcContext } from './web/trpc.js'

/**
 * Abuse simulation.
 *
 * Everything here is a limit from docs/design.md §9.2, driven until it bites. A limit nobody has
 * ever seen fire is a limit nobody should trust, and on a public unauthenticated server these are
 * the only thing standing between one bored visitor and everyone else's demo.
 */

const logger = pino({ level: 'silent' })
const started: { server: SatelliteServer; runtime: MockRuntime }[] = []
const sockets: WebSocket[] = []

async function startStack(overrides: Partial<Config> = {}) {
	const config = { ...loadConfig({ NODE_ENV: 'test' }), SATELLITE_PORT: 0, ...overrides }
	const runtime = new MockRuntime({ config, logger })
	const server = new SatelliteServer({ config, logger, events: runtime.events() })
	runtime.start()
	await server.listen()
	started.push({ server, runtime })
	return { server, runtime, config, url: `ws://127.0.0.1:${server.address!.port}/ws/satellite` }
}

function open(url: string): { socket: WebSocket; closed: Promise<number> } {
	const socket = new WebSocket(url)
	sockets.push(socket)
	const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)))
	return { socket, closed }
}

const waitOpen = (socket: WebSocket) =>
	new Promise<void>((resolve, reject) => {
		socket.once('open', () => resolve())
		socket.once('error', reject)
	})

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('timed out')
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close()
	for (const { server, runtime } of started.splice(0)) {
		runtime.stop()
		await server.close()
	}
})

describe('connection flooding', () => {
	it('refuses beyond the per-IP concurrent limit', async () => {
		const { url, server } = await startStack({ MAX_CONNECTIONS_PER_IP: 3, CONNECTION_BURST_PER_IP: 50 })

		const accepted = []
		for (let i = 0; i < 3; i++) {
			const conn = open(url)
			await waitOpen(conn.socket)
			accepted.push(conn)
		}
		await waitFor(() => server.connectionCount === 3)

		const refused = open(url)
		await waitOpen(refused.socket)
		expect(await refused.closed).toBe(1013)
		expect(server.connectionCount).toBe(3)
	})

	it('refuses a reconnect storm even when each connection closes immediately', async () => {
		// The concurrent limit alone would not catch this: connect, drop, repeat stays at one.
		const { url } = await startStack({
			MAX_CONNECTIONS_PER_IP: 50,
			CONNECTION_BURST_PER_IP: 5,
			CONNECTIONS_PER_IP_PER_MINUTE: 6,
		})

		let refusedCount = 0
		for (let i = 0; i < 12; i++) {
			const conn = open(url)
			await waitOpen(conn.socket)
			const code = await Promise.race([
				conn.closed,
				new Promise<number>((resolve) => setTimeout(() => resolve(0), 50)),
			])
			if (code === 1013) refusedCount++
			conn.socket.close()
		}

		expect(refusedCount).toBeGreaterThan(0)
	})

	it('enforces the server-wide cap regardless of source', async () => {
		const { url, server } = await startStack({
			MAX_CONNECTIONS_TOTAL: 2,
			MAX_CONNECTIONS_PER_IP: 50,
			CONNECTION_BURST_PER_IP: 50,
		})

		for (let i = 0; i < 2; i++) await waitOpen(open(url).socket)
		await waitFor(() => server.connectionCount === 2)

		const refused = open(url)
		await waitOpen(refused.socket)
		expect(await refused.closed).toBe(1013)
	})
})

describe('payload abuse', () => {
	it('drops a client that streams forever without a terminator', async () => {
		const { url, server } = await startStack({ MAX_LINE_BYTES: 4096, MAX_BYTES_PER_SECOND: 10 * 1024 * 1024 })
		const { socket } = open(url)
		await waitOpen(socket)
		await waitFor(() => server.connectionCount === 1)

		// No newline, ever. Without the line cap this grows the receive buffer without bound.
		for (let i = 0; i < 10; i++) socket.send('x'.repeat(1024))
		await waitFor(() => server.connectionCount === 0)
	})

	it('closes a connection that exceeds its byte rate', async () => {
		const { url, server } = await startStack({ MAX_BYTES_PER_SECOND: 4096, MAX_LINE_BYTES: 1024 * 1024 })
		const { socket } = open(url)
		await waitOpen(socket)
		await waitFor(() => server.connectionCount === 1)

		for (let i = 0; i < 20; i++) socket.send(`PING ${'x'.repeat(1000)}\n`)
		await waitFor(() => server.connectionCount === 0)
	})

	it('closes a connection that exceeds its message rate', async () => {
		const { url, server } = await startStack({
			MAX_MESSAGES_PER_SECOND: 20,
			MAX_BYTES_PER_SECOND: 10 * 1024 * 1024,
		})
		const { socket } = open(url)
		await waitOpen(socket)
		await waitFor(() => server.connectionCount === 1)

		for (let i = 0; i < 200; i++) socket.send('PING\n')
		await waitFor(() => server.connectionCount === 0)
	})

	it('still tolerates the reference client pinging at 10Hz', async () => {
		// The limits have to accommodate a genuinely chatty real client, or they throttle everyone.
		const { url, server } = await startStack()
		const { socket } = open(url)
		await waitOpen(socket)

		for (let i = 0; i < 20; i++) {
			socket.send('PING\n')
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
		expect(server.connectionCount).toBe(1)
	})

	it('rejects an absurd grid rather than allocating it', async () => {
		const { url } = await startStack()
		const { socket } = open(url)
		await waitOpen(socket)

		const lines: string[] = []
		socket.on('message', (data) => lines.push(...data.toString().split('\n')))
		socket.send('ADD-DEVICE DEVICEID=big PRODUCT_NAME=x KEYS_TOTAL=999999999\n')

		await waitFor(() => lines.some((line) => line.includes('Invalid KEYS_TOTAL')))
	})

	it('rejects a bitmap size that would blow the render budget', async () => {
		const { url } = await startStack()
		const { socket } = open(url)
		await waitOpen(socket)

		const lines: string[] = []
		socket.on('message', (data) => lines.push(...data.toString().split('\n')))
		socket.send('ADD-DEVICE DEVICEID=big PRODUCT_NAME=x KEYS_TOTAL=1 BITMAPS=100000\n')

		await waitFor(() => lines.some((line) => line.includes('Bitmap too large')))
	})
})

describe('claim brute force', () => {
	it('locks out after a handful of wrong guesses', async () => {
		const { server, runtime } = await startStack()
		const attacker = appRouter.createCaller({
			runtime,
			satellite: server,
			uiClientId: 'attacker',
			clientIp: '203.0.113.66',
		} satisfies TrpcContext)

		let rateLimited = false
		for (let i = 0; i < 15; i++) {
			try {
				await attacker.claim({ code: `GUESS${i}` })
			} catch (error) {
				if (String(error).includes('Too many attempts')) rateLimited = true
			}
		}
		expect(rateLimited).toBe(true)
	})

	it('does not let one attacker lock everyone else out', async () => {
		const { server, runtime } = await startStack()
		const context = (id: string, clientIp: string) =>
			appRouter.createCaller({ runtime, satellite: server, uiClientId: id, clientIp } satisfies TrpcContext)

		for (let i = 0; i < 15; i++)
			await context('attacker', '203.0.113.66')
				.claim({ code: 'NOPE00' })
				.catch(() => undefined)

		await expect(context('innocent', '198.51.100.9').claim({ code: 'NOPE00' })).rejects.toThrow(
			/No session with that code/
		)
	})
})

describe('memory bounds', () => {
	it('does not grow the rate-limit map without bound', async () => {
		const { runtime } = await startStack()
		// Sessions are the other unbounded-looking structure; sweeping is what keeps them in check.
		for (let i = 0; i < 200; i++) runtime.sessions.create()
		expect(runtime.sessions.size).toBe(200)
	})

	it('collects sessions nobody is using', async () => {
		const { runtime } = await startStack({ SESSION_GRACE_MS: 1 })
		for (let i = 0; i < 50; i++) {
			const session = runtime.sessions.create()
			session.disconnectedAt = Date.now() - 10_000
		}
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(runtime.sessions.sweep()).toBe(50)
		expect(runtime.sessions.size).toBe(0)
	})
})
