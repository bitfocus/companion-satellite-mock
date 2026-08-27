import { TestSatelliteClient } from '@satellite-mock/testclient'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, type Config } from './config.js'
import { MockRuntime } from './runtime.js'
import { SatelliteServer } from './satelliteServer.js'

/**
 * End-to-end through the real stack: socket, protocol, session, scenario, renderer, emitter.
 *
 * Driven by the headless test client, which shares nothing with the server but the protocol package
 * — so a framing or dispatch bug cannot hide by being symmetrical on both sides.
 */

const logger = pino({ level: 'silent' })
const started: { server: SatelliteServer; runtime: MockRuntime }[] = []
const clients: TestSatelliteClient[] = []

async function startStack(overrides: Partial<Config> = {}) {
	const config = { ...loadConfig({ NODE_ENV: 'test' }), SATELLITE_PORT: 0, ...overrides }
	const runtime = new MockRuntime({ config, logger, publicUrl: 'mock.test' })
	const server = new SatelliteServer({ config, logger, events: runtime.events() })
	runtime.start()
	await server.listen()
	started.push({ server, runtime })
	return { server, runtime, url: `ws://127.0.0.1:${server.address!.port}/ws/satellite` }
}

async function connectClient(url: string, pingIntervalMs = 0): Promise<TestSatelliteClient> {
	const client = new TestSatelliteClient({ url, pingIntervalMs })
	clients.push(client)
	await client.connect()
	return client
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close()
	for (const { server, runtime } of started.splice(0)) {
		runtime.stop()
		await server.close()
	}
})

const decode = (value: string | true | undefined) =>
	typeof value === 'string' ? Buffer.from(value, 'base64').toString() : ''

describe('a client that just connects', () => {
	it('gets a live surface with no web UI involved — the zero-interaction path', async () => {
		const { url, runtime } = await startStack()
		const client = await connectClient(url)

		await client.waitFor('BEGIN')
		await client.addDevice('streamdeck:evaluator', { KEYS_TOTAL: 32, KEYS_PER_ROW: 8, COLORS: 'hex', TEXT: 1 })

		const states = await client.waitForCount('KEY-STATE', 32)
		expect(states.length).toBeGreaterThanOrEqual(32)

		// The claim code is drawn onto the surface, so there is nothing to copy out of the app.
		const session = runtime.sessions.all()[0]!
		const texts = states.map((m) => decode(m.params.TEXT))
		// The label wraps as `UN-\nCLAIMED` on a small button, so compare with the wrapping removed.
		expect(texts.join(' ').replace(/-?\n/g, '')).toContain('UNCLAIMED')

		const codeChars = session.claimCode.split('')
		for (const char of codeChars) {
			expect(texts, `claim code character ${char}`).toContain(char)
		}
	})

	it('responds to a press without anyone claiming it', async () => {
		const { url } = await startStack()
		const client = await connectClient(url)
		await client.addDevice('dev1', { KEYS_TOTAL: 8, KEYS_PER_ROW: 4, COLORS: 'hex', TEXT: 1 })
		await client.waitForCount('KEY-STATE', 8)
		client.clearReceived()

		client.sendMessage('KEY-PRESS', { DEVICEID: 'dev1', KEY: 7, PRESSED: true })
		const states = await client.waitForCount('KEY-STATE', 1)
		expect(states[0]!.params.PRESSED).toBe('1')
	})

	it('keeps the same claim code across a reconnect', async () => {
		const { url, runtime } = await startStack()
		const first = await connectClient(url)
		await first.addDevice('streamdeck:stable', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex' })
		await first.waitForCount('KEY-STATE', 4)
		const code = runtime.sessions.all()[0]!.claimCode

		first.close()
		await new Promise((resolve) => setTimeout(resolve, 100))

		const second = await connectClient(url)
		await second.addDevice('streamdeck:stable', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex' })
		await second.waitForCount('KEY-STATE', 4)

		expect(runtime.sessions.size).toBe(1)
		expect(runtime.sessions.all()[0]!.claimCode).toBe(code)
	})

	it('gives a client that changes its device id a new session and code', async () => {
		// The failure mode a client author will actually hit if they mint an id per launch.
		const { url, runtime } = await startStack()
		const first = await connectClient(url)
		await first.addDevice('random:aaa', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2 })
		await first.waitForCount('KEY-STATE', 4)

		const second = await connectClient(url)
		await second.addDevice('random:bbb', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2 })
		await second.waitForCount('KEY-STATE', 4)

		expect(runtime.sessions.size).toBe(2)
	})
})

describe('scenarios over the wire', () => {
	async function withSurface(add: Record<string, string | number | boolean> = {}) {
		const { url, runtime } = await startStack()
		const client = await connectClient(url)
		await client.addDevice('dev1', { KEYS_TOTAL: 8, KEYS_PER_ROW: 4, COLORS: 'hex', TEXT: 1, ...add })
		await client.waitForCount('KEY-STATE', 8)
		client.clearReceived()
		return { client, runtime }
	}

	it('switches scenario and redraws the surface', async () => {
		const { client, runtime } = await withSurface()
		expect(runtime.selectScenario('dev1', 'colour-text')).toBe(true)

		await client.waitFor('KEYS-CLEAR')
		const states = await client.waitForCount('KEY-STATE', 8)
		expect(states.map((m) => decode(m.params.TEXT)).join(' ')).toContain('MiXeD CaSe')
	})

	it('rejects an unknown scenario id', async () => {
		const { runtime } = await withSurface()
		expect(runtime.selectScenario('dev1', 'no-such-scenario')).toBe(false)
	})

	it('input echo reports the control the server resolved, not the raw key', async () => {
		const { client, runtime } = await withSurface()
		runtime.selectScenario('dev1', 'input-echo')
		await client.waitForCount('KEY-STATE', 8)
		client.clearReceived()

		// Key 5 on a 4-wide grid is row 1, column 1.
		client.sendMessage('KEY-PRESS', { DEVICEID: 'dev1', KEY: 5, PRESSED: true })
		const states = await client.waitForCount('KEY-STATE', 1)
		expect(states.map((m) => decode(m.params.TEXT)).join(' ')).toContain('1/1')
	})

	it('encoder lab reports the raw rotation delta, so multi-step rotation is visible', async () => {
		const { client, runtime } = await withSurface()
		runtime.selectScenario('dev1', 'encoder-lab')
		await client.waitForCount('KEY-STATE', 8)
		client.clearReceived()

		client.sendMessage('KEY-ROTATE', { DEVICEID: 'dev1', KEY: 0, DIRECTION: 4 })
		const states = await client.waitForCount('KEY-STATE', 1)
		expect(states.map((m) => decode(m.params.TEXT)).join(' ')).toContain('d=+4')
	})

	it('brightness ramp reaches the client, and stops for one that opted out', async () => {
		const withBrightness = await withSurface()
		withBrightness.runtime.selectScenario('dev1', 'brightness')
		const messages = await withBrightness.client.waitForCount('BRIGHTNESS', 2, 3000)
		expect(Number(messages[0]!.params.VALUE)).toBeGreaterThanOrEqual(0)

		const optedOut = await startStack()
		const client = await connectClient(optedOut.url)
		await client.addDevice('dev2', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex', BRIGHTNESS: 0 })
		await client.waitForCount('KEY-STATE', 4)
		optedOut.runtime.selectScenario('dev2', 'brightness')

		await new Promise((resolve) => setTimeout(resolve, 600))
		expect(client.messagesOf('BRIGHTNESS')).toHaveLength(0)
	})

	it('the pincode scenario drives LOCKED-STATE and unlocks on the right code', async () => {
		const { url, runtime } = await startStack()
		const client = await connectClient(url)
		await client.addDevice('dev1', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex', PINCODE_LOCK: 'FULL' })
		await client.waitForCount('KEY-STATE', 4)
		client.clearReceived()

		runtime.selectScenario('dev1', 'pincode')
		const locked = await client.waitFor('LOCKED-STATE')
		expect(locked.params.LOCKED).toBe('1')

		for (const digit of ['1', '2', '3', '4']) {
			client.sendMessage('PINCODE-KEY', { DEVICEID: 'dev1', KEY: digit })
		}

		const states = await client.waitForCount('LOCKED-STATE', 2, 3000)
		expect(states.some((m) => m.params.LOCKED === '0')).toBe(true)
	})

	it('the variables scenario streams only declared output variables', async () => {
		const { url, runtime } = await startStack()
		const client = await connectClient(url)
		const variables = Buffer.from(
			JSON.stringify([
				{ id: 'out-1', type: 'output', name: 'Out one' },
				{ id: 'in-1', type: 'input', name: 'In one' },
			])
		).toString('base64')

		await client.addDevice('dev1', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex', VARIABLES: variables })
		await client.waitForCount('KEY-STATE', 4)
		runtime.selectScenario('dev1', 'variables')

		const values = await client.waitForCount('VARIABLE-VALUE', 1, 3000)
		expect(values.every((m) => m.params.VARIABLE === 'out-1')).toBe(true)
	})

	it('degrades on a surface with no bitmaps rather than failing', async () => {
		const { client, runtime } = await withSurface({ BITMAPS: 0 })
		runtime.selectScenario('dev1', 'bitmap-torture')
		const states = await client.waitForCount('KEY-STATE', 8)
		expect(states.every((m) => m.params.BITMAP === undefined)).toBe(true)
		expect(states.some((m) => m.params.COLOR !== undefined)).toBe(true)
	})

	it('sends bitmaps when the client asked for them', async () => {
		const { client, runtime } = await withSurface({ BITMAPS: 32 })
		runtime.selectScenario('dev1', 'bitmap-torture')
		const states = await client.waitForCount('KEY-STATE', 8)

		const withBitmap = states.filter((m) => typeof m.params.BITMAP === 'string')
		expect(withBitmap.length).toBeGreaterThan(0)
		expect(Buffer.from(withBitmap[0]!.params.BITMAP as string, 'base64')).toHaveLength(32 * 32 * 3)
	})

	it('sends png as a data url when negotiated', async () => {
		const { client, runtime } = await withSurface({ BITMAPS: 16, BITMAP_FORMAT: 'png' })
		runtime.selectScenario('dev1', 'colour-text')
		const states = await client.waitForCount('KEY-STATE', 8)
		const bitmap = states.find((m) => typeof m.params.BITMAP === 'string')!.params.BITMAP as string
		expect(bitmap.startsWith('data:image/png;base64,')).toBe(true)
	})
})

describe('a second client using an already-registered device id', () => {
	const SURFACE = { KEYS_TOTAL: 8, KEYS_PER_ROW: 4, COLORS: 'hex', TEXT: 1 } as const

	it('is told why on the surface itself, rather than left waiting', async () => {
		const { url } = await startStack()

		const first = await connectClient(url)
		await first.addDevice('shared:id', SURFACE)
		await first.waitForCount('KEY-STATE', 8)

		const second = await connectClient(url)
		await second.addDevice('shared:id', SURFACE)

		// The surface it is drawn is the only channel that reaches this client: it has no claim code,
		// so it can never reach the web UI to be told anything.
		const states = await second.waitForCount('KEY-STATE', 3, 5000)
		const texts = states.map((message) => decode(message.params.TEXT))

		expect(texts.join(' ')).toContain("CAN'T")
		expect(texts.join(' ')).toContain('ID IN')
		// Names the id, so a developer running two builds knows which one collided.
		expect(texts).toContain('shared:id')
	})

	it('says on-screen what Companion really does, so the divergence teaches rather than hides', async () => {
		const { url } = await startStack()

		const first = await connectClient(url)
		await first.addDevice('shared:id', SURFACE)
		await first.waitForCount('KEY-STATE', 8)

		const second = await connectClient(url)
		await second.addDevice('shared:id', SURFACE)
		const states = await second.waitForCount('KEY-STATE', 5, 5000)
		const all = states.map((message) => decode(message.params.TEXT)).join(' ')

		expect(all).toContain('COMPANION')
		expect(all).toContain('?duplicates')
	})

	it('does not disturb what the first client is showing', async () => {
		const { url } = await startStack()

		const first = await connectClient(url)
		await first.addDevice('shared:id', SURFACE)
		await first.waitForCount('KEY-STATE', 8)
		const before = first.messagesOf('KEY-STATE').length

		const second = await connectClient(url)
		await second.addDevice('shared:id', SURFACE)
		await second.waitForCount('KEY-STATE', 3, 5000)

		// The holder receives its ADD-DEVICE error and nothing else — its surface is untouched.
		expect(first.messagesOf('KEY-STATE').length).toBe(before)
		expect(first.messagesOf('ADD-DEVICE').at(-1)?.params.MESSAGE).toBe('Device exists elsewhere')
	})

	it('a surface too small for the extras still shows the essential two', async () => {
		const { url } = await startStack()

		const first = await connectClient(url)
		await first.addDevice('shared:id', { KEYS_TOTAL: 2, KEYS_PER_ROW: 2, COLORS: 'hex', TEXT: 1 })
		await first.waitForCount('KEY-STATE', 2)

		const second = await connectClient(url)
		await second.addDevice('shared:id', { KEYS_TOTAL: 2, KEYS_PER_ROW: 2, COLORS: 'hex', TEXT: 1 })
		const states = await second.waitForCount('KEY-STATE', 2, 5000)
		const texts = states.map((message) => decode(message.params.TEXT)).join(' ')

		// Priority order matters: the reason must survive on a surface with no room for the rest.
		expect(texts).toContain("CAN'T")
		expect(texts).toContain('ID IN')
	})
})
