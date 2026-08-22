import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { pino } from 'pino'
import { loadConfig, type Config } from './config.js'
import { SatelliteServer } from './satelliteServer.js'

/**
 * End-to-end tests over a real WebSocket against a real listener.
 *
 * Unit tests cover the pieces; these exist because the interesting failures in a transport are in
 * the wiring — a handshake that never sends, a teardown that leaks a registry slot, a timeout that
 * fires on a busy connection.
 */

const logger = pino({ level: 'silent' })
const servers: SatelliteServer[] = []
const sockets: WebSocket[] = []

async function startServer(overrides: Partial<Config> = {}): Promise<{ server: SatelliteServer; url: string }> {
	const config = { ...loadConfig({ NODE_ENV: 'test' }), SATELLITE_PORT: 0, ...overrides }
	const server = new SatelliteServer({ config, logger })
	await server.listen()
	servers.push(server)
	return { server, url: `ws://127.0.0.1:${server.address!.port}/ws/satellite` }
}

/** Connect and collect every line the server sends, split on the terminator it actually uses. */
function connect(url: string): { socket: WebSocket; lines: string[]; opened: Promise<void> } {
	const socket = new WebSocket(url)
	sockets.push(socket)
	const lines: string[] = []
	socket.on('message', (data) => {
		for (const line of data.toString().split('\n')) {
			if (line.length > 0) lines.push(line)
		}
	})
	const opened = new Promise<void>((resolve, reject) => {
		socket.once('open', () => resolve())
		socket.once('error', reject)
	})
	return { socket, lines, opened }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close()
	for (const server of servers.splice(0)) await server.close()
})

describe('SatelliteServer', () => {
	it('sends BEGIN then CAPS on connect', async () => {
		const { url } = await startServer()
		const { lines, opened } = connect(url)
		await opened
		await waitFor(() => lines.length >= 2)

		expect(lines[0]).toMatch(/^BEGIN CompanionVersion=".+" ApiVersion="1\.14\.0" $/)
		expect(lines[1]).toMatch(/^CAPS SUBSCRIPTIONS=1 NONSQUARE=1 BITMAP_FORMATS="rgb,png,webp" ROTARY_AMOUNT=1 $/)
	})

	it('answers PING with the payload echoed raw', async () => {
		const { url } = await startServer()
		const { socket, lines, opened } = connect(url)
		await opened
		await waitFor(() => lines.length >= 2)

		socket.send('PING some "arbitrary" payload\n')
		await waitFor(() => lines.some((l) => l.startsWith('PONG')))
		expect(lines.find((l) => l.startsWith('PONG'))).toBe('PONG some "arbitrary" payload ')
	})

	it('reassembles a command split across many frames', async () => {
		// One frame is not one message. A client that assumes otherwise passes every normal test and
		// fails in production, so the server must not make the same assumption.
		const { url } = await startServer()
		const { socket, lines, opened } = connect(url)
		await opened
		await waitFor(() => lines.length >= 2)

		for (const char of 'PING split\n') socket.send(char)
		await waitFor(() => lines.some((l) => l.startsWith('PONG')))
		expect(lines.find((l) => l.startsWith('PONG'))).toBe('PONG split ')
	})

	it('handles several commands coalesced into one frame', async () => {
		const { url } = await startServer()
		const { socket, lines, opened } = connect(url)
		await opened
		await waitFor(() => lines.length >= 2)

		socket.send('PING a\nPING b\nPING c\n')
		await waitFor(() => lines.filter((l) => l.startsWith('PONG')).length === 3)
		expect(lines.filter((l) => l.startsWith('PONG'))).toEqual(['PONG a ', 'PONG b ', 'PONG c '])
	})

	it('rejects an unknown command without a status token', async () => {
		const { url } = await startServer()
		const { socket, lines, opened } = connect(url)
		await opened
		await waitFor(() => lines.length >= 2)

		socket.send('NONSENSE\n')
		await waitFor(() => lines.some((l) => l.startsWith('ERROR')))
		expect(lines.find((l) => l.startsWith('ERROR'))).toBe('ERROR MESSAGE="Unknown command: NONSENSE" ')
	})

	it('uppercases the command before dispatching', async () => {
		const { url } = await startServer()
		const { socket, lines, opened } = connect(url)
		await opened
		await waitFor(() => lines.length >= 2)

		socket.send('ping lower\n')
		await waitFor(() => lines.some((l) => l.startsWith('PONG')))
		expect(lines.find((l) => l.startsWith('PONG'))).toBe('PONG lower ')
	})

	it('closes the connection on QUIT', async () => {
		const { url, server } = await startServer()
		const { socket, lines, opened } = connect(url)
		await opened
		await waitFor(() => lines.length >= 2)

		socket.send('QUIT\n')
		await waitFor(() => server.connectionCount === 0)
	})

	it('emits the doubled-ERROR line-too-long response and closes', async () => {
		const { url, server } = await startServer({
			MAX_LINE_BYTES: 512,
			MAX_FRAME_BYTES: 1024 * 1024,
			MAX_BYTES_PER_SECOND: 1024 * 1024,
		})
		const { socket, lines, opened } = connect(url)
		await opened
		await waitFor(() => lines.length >= 2)

		socket.send('X'.repeat(600))
		await waitFor(() => lines.some((l) => l.includes('Line too long')))
		expect(lines.find((l) => l.includes('Line too long'))).toBe('ERROR ERROR MESSAGE="Line too long" ')
		await waitFor(() => server.connectionCount === 0)
	})

	it('drops an idle connection on the configured timeout', async () => {
		const { url, server } = await startServer({ IDLE_TIMEOUT_MS: 100, IDLE_CHECK_INTERVAL_MS: 20 })
		const { opened } = connect(url)
		await opened
		await waitFor(() => server.connectionCount === 1)
		await waitFor(() => server.connectionCount === 0, 3000)
	})

	it('keeps a pinging connection alive past the idle timeout', async () => {
		const { url, server } = await startServer({ IDLE_TIMEOUT_MS: 150, IDLE_CHECK_INTERVAL_MS: 20 })
		const { socket, opened } = connect(url)
		await opened

		const pinger = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send('PING\n'), 30)
		try {
			await new Promise((resolve) => setTimeout(resolve, 500))
			expect(server.connectionCount).toBe(1)
		} finally {
			clearInterval(pinger)
		}
	})

	it('refuses connections beyond the per-ip limit', async () => {
		const { url, server } = await startServer({ MAX_CONNECTIONS_PER_IP: 2, CONNECTION_BURST_PER_IP: 10 })
		const first = connect(url)
		const second = connect(url)
		await Promise.all([first.opened, second.opened])
		await waitFor(() => server.connectionCount === 2)

		const third = connect(url)
		await third.opened
		const closeCode = await new Promise<number>((resolve) => third.socket.once('close', resolve))
		expect(closeCode).toBe(1013)
		expect(server.connectionCount).toBe(2)
	})

	it('frees the slot again once a connection closes', async () => {
		const { url, server } = await startServer({ MAX_CONNECTIONS_PER_IP: 1, CONNECTION_BURST_PER_IP: 10 })
		const first = connect(url)
		await first.opened
		await waitFor(() => server.connectionCount === 1)

		first.socket.close()
		await waitFor(() => server.connectionCount === 0)

		const second = connect(url)
		await second.opened
		await waitFor(() => server.connectionCount === 1)
	})

	it('accepts a frame far larger than the line limit when it holds many short lines', () => {
		// The frame cap and the line cap are different limits. Tying them together kills a client
		// that batches its writes, which is exactly what a busy surface does.
		return (async () => {
			const { url } = await startServer({ MAX_LINE_BYTES: 512, MAX_BYTES_PER_SECOND: 8 * 1024 * 1024 })
			const { socket, lines, opened } = connect(url)
			await opened
			await waitFor(() => lines.length >= 2)

			const batch = Array.from({ length: 200 }, (_, i) => `PING p${i}`).join('\n') + '\n'
			expect(batch.length).toBeGreaterThan(512)
			socket.send(batch)

			await waitFor(() => lines.filter((l) => l.startsWith('PONG')).length === 200)
		})()
	})

	it('answers plain HTTP with 426 rather than anything useful', async () => {
		const { server } = await startServer()
		const response = await fetch(`http://127.0.0.1:${server.address!.port}/`)
		expect(response.status).toBe(426)
	})
})
