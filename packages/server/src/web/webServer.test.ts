import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { loadConfig } from '../config.js'
import { MockRuntime } from '../runtime.js'
import { SatelliteServer } from '../satelliteServer.js'
import { WebServer } from './webServer.js'

const logger = pino({ level: 'silent' })
const cleanup: (() => Promise<void> | void)[] = []

afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function startWeb() {
	const config = { ...loadConfig({ NODE_ENV: 'test' }), SATELLITE_PORT: 0, WEB_PORT: 0 }
	const runtime = new MockRuntime({ config, logger })
	const satellite = new SatelliteServer({ config, logger, events: runtime.events() })
	const web = new WebServer({ config, logger, runtime, satellite, staticDir: undefined })
	await web.listen()
	cleanup.push(() => web.close())
	return `ws://127.0.0.1:${web.address!.port}/ws/trpc`
}

/** Resolves with the socket once open, or with the close/error that happened instead. */
function open(url: string): Promise<{ ws: WebSocket; opened: boolean }> {
	return new Promise((resolve) => {
		const ws = new WebSocket(url)
		cleanup.push(() => ws.terminate())
		ws.once('open', () => resolve({ ws, opened: true }))
		ws.once('error', () => resolve({ ws, opened: false }))
	})
}

describe('the web UI socket', () => {
	it('caps how many UI sockets one address may hold, and frees a slot on close', async () => {
		const url = await startWeb()
		const held = []
		for (let i = 0; i < 16; i++) held.push(await open(url))
		expect(held.every((socket) => socket.opened)).toBe(true)

		expect((await open(url)).opened).toBe(false)

		const closed = new Promise((resolve) => held[0]!.ws.once('close', resolve))
		held[0]!.ws.close()
		await closed
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect((await open(url)).opened).toBe(true)
	})

	it('closes a socket that sends an oversized message, rather than buffering it', async () => {
		const url = await startWeb()
		const { ws } = await open(url)
		const code = new Promise<number>((resolve) => ws.once('close', (closeCode) => resolve(closeCode)))
		ws.send('x'.repeat(256 * 1024))
		expect(await code).toBe(1009) // message too big
	})
})
