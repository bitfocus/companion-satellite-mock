import { TestSatelliteClient } from '@satellite-mock/testclient'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, type Config } from '../config.js'
import { MockRuntime } from '../runtime.js'
import { SatelliteServer } from '../satelliteServer.js'
import { appRouter, type TrpcContext } from './trpc.js'

/**
 * The API, exercised through the router directly rather than over a socket.
 *
 * The transport is already covered elsewhere; what matters here is authorisation and the shape of
 * what the UI receives. Every test uses a *real* satellite client, because a snapshot of a device
 * that was never registered proves nothing.
 */

const logger = pino({ level: 'silent' })
const started: { server: SatelliteServer; runtime: MockRuntime }[] = []
const clients: TestSatelliteClient[] = []

async function startStack(overrides: Partial<Config> = {}) {
	const config = { ...loadConfig({ NODE_ENV: 'test' }), SATELLITE_PORT: 0, ...overrides }
	const runtime = new MockRuntime({ config, logger, publicUrl: 'mock.test' })
	const server = new SatelliteServer({
		config,
		logger,
		events: {
			...runtime.events(),
			onLine: (session, direction, line) => runtime.sessions.forConnection(session)?.record(direction, line),
		},
	})
	runtime.start()
	await server.listen()
	started.push({ server, runtime })

	const caller = (uiClientId: string) =>
		appRouter.createCaller({ runtime, satellite: server, uiClientId } satisfies TrpcContext)
	return { server, runtime, caller, url: `ws://127.0.0.1:${server.address!.port}/ws/satellite` }
}

async function connectDevice(url: string, deviceId = 'dev1') {
	const client = new TestSatelliteClient({ url, pingIntervalMs: 0 })
	clients.push(client)
	await client.connect()
	await client.addDevice(deviceId, { KEYS_TOTAL: 8, KEYS_PER_ROW: 4, COLORS: 'hex', TEXT: 1, BITMAPS: 32 })
	await client.waitForCount('KEY-STATE', 8)
	return client
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close()
	for (const { server, runtime } of started.splice(0)) {
		runtime.stop()
		await server.close()
	}
})

describe('claiming', () => {
	it('claims with the code and switches the surface off Unclaimed', async () => {
		const { url, runtime, caller } = await startStack()
		const client = await connectDevice(url)
		const code = runtime.sessions.all()[0]!.claimCode

		const api = caller('browser-1')
		const { sessionId } = await api.claim({ code })
		expect(sessionId).toBe(runtime.sessions.all()[0]!.id)

		// The visible signal that the claim worked is on the surface, not just in the browser.
		const states = await client.waitForCount('KEY-STATE', 9)
		expect(states.length).toBeGreaterThan(8)
	})

	it('accepts the code in its displayed form, with the separator', async () => {
		const { url, runtime, caller } = await startStack()
		await connectDevice(url)
		const code = runtime.sessions.all()[0]!.claimCode
		const displayed = `${code.slice(0, 3)}-${code.slice(3)}`

		await expect(caller('browser-1').claim({ code: displayed })).resolves.toBeTruthy()
	})

	it('rejects an unknown code', async () => {
		const { caller } = await startStack()
		await expect(caller('browser-1').claim({ code: 'ZZZZZZ' })).rejects.toThrow(/No session with that code/)
	})

	it('rate limits repeated guesses', async () => {
		const { caller } = await startStack()
		const api = caller('guesser')
		for (let i = 0; i < 5; i++) await expect(api.claim({ code: 'ZZZZZZ' })).rejects.toThrow()
		await expect(api.claim({ code: 'ZZZZZZ' })).rejects.toThrow(/Too many attempts/)
	})
})

describe('authorisation', () => {
	async function claimed() {
		const { url, runtime, caller } = await startStack()
		const client = await connectDevice(url)
		const code = runtime.sessions.all()[0]!.claimCode
		const owner = caller('owner')
		const { sessionId } = await owner.claim({ code })
		return { runtime, caller, owner, sessionId, client }
	}

	it('lets the holder read and act on the session', async () => {
		const { owner, sessionId } = await claimed()
		const snapshot = await owner.session({ sessionId })
		expect(snapshot?.device?.id).toBe('dev1')
		await expect(owner.selectScenario({ sessionId, scenarioId: 'colour-text' })).resolves.toEqual({ ok: true })
	})

	it('refuses another browser, even though session contents are not secret', async () => {
		const { caller, sessionId } = await claimed()
		const stranger = caller('stranger')
		await expect(stranger.session({ sessionId })).rejects.toThrow(/not claimed by you/)
		await expect(stranger.selectScenario({ sessionId, scenarioId: 'attract' })).rejects.toThrow(
			/not claimed by you/
		)
		await expect(stranger.sendRaw({ sessionId, line: 'KEYS-CLEAR' })).rejects.toThrow(/not claimed by you/)
	})

	it('lists only the sessions this browser holds', async () => {
		const { caller, owner } = await claimed()
		expect(await owner.mySessions()).toHaveLength(1)
		expect(await caller('stranger').mySessions()).toHaveLength(0)
	})

	it('releases the session and mints a new code on unclaim', async () => {
		const { owner, sessionId, runtime } = await claimed()
		const before = runtime.sessions.get(sessionId)!.claimCode
		await owner.unclaim({ sessionId })

		expect(runtime.sessions.get(sessionId)!.claimCode).not.toBe(before)
		await expect(owner.session({ sessionId })).rejects.toThrow(/not claimed by you/)
	})
})

describe('session data for the UI', () => {
	async function claimed() {
		const { url, runtime, caller } = await startStack()
		const client = await connectDevice(url)
		const owner = caller('owner')
		const { sessionId } = await owner.claim({ code: runtime.sessions.all()[0]!.claimCode })
		return { runtime, owner, sessionId, client }
	}

	it('reports what the client negotiated', async () => {
		const { owner, sessionId } = await claimed()
		const snapshot = await owner.session({ sessionId })

		expect(snapshot?.device).toMatchObject({
			id: 'dev1',
			productName: 'Test Client',
			gridSize: { rows: 2, columns: 4 },
			fromManifest: false,
			bitmapFormat: 'rgb',
			supportsBrightness: true,
		})
		expect(snapshot?.connected).toBe(true)
		expect(snapshot?.apiVersion).toBe('1.14.0')
	})

	it('surfaces a reported firmware url as inert text', async () => {
		const { owner, sessionId, client } = await claimed()
		client.sendMessage('FIRMWARE-UPDATE-INFO', { DEVICEID: 'dev1', UPDATE_URL: 'https://example.invalid/fw' })
		await client.waitFor('FIRMWARE-UPDATE-INFO')

		const snapshot = await owner.session({ sessionId })
		expect(snapshot?.device?.firmwareUpdateUrl).toBe('https://example.invalid/fw')
	})

	it('refuses a raw line that would corrupt the wire format', async () => {
		const { owner, sessionId } = await claimed()
		await expect(owner.sendRaw({ sessionId, line: 'X TEXT="oops' })).rejects.toThrow(/quotes or newlines/)
		await expect(owner.sendRaw({ sessionId, line: 'X\nY' })).rejects.toThrow(/quotes or newlines/)
	})

	it('delivers a raw line to the client', async () => {
		const { owner, sessionId, client } = await claimed()
		client.clearReceived()
		await owner.sendRaw({ sessionId, line: 'KEYS-CLEAR DEVICEID=dev1' })
		await client.waitFor('KEYS-CLEAR')
	})

	it('force-disconnects the client', async () => {
		const { owner, sessionId, client } = await claimed()
		const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
		await owner.disconnect({ sessionId })
		await closed
	})

	it('lists the scenario catalogue', async () => {
		const { owner } = await claimed()
		const scenarios = await owner.scenarios()
		expect(scenarios.map((s) => s.id)).toContain('colour-text')
		expect(scenarios.every((s) => s.description.length > 0)).toBe(true)
	})
})
