import { TestSatelliteClient } from '@satellite-mock/testclient'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { MockRuntime } from './runtime.js'
import { SatelliteServer } from './satelliteServer.js'

/**
 * The version selector, end to end.
 *
 * The whole point of the feature is that picking an older API version produces a genuinely older
 * server, not a cosmetically older banner — so these assert on what actually crosses the wire.
 */

const logger = pino({ level: 'silent' })
const started: { server: SatelliteServer; runtime: MockRuntime }[] = []
const clients: TestSatelliteClient[] = []

async function startStack() {
	const config = { ...loadConfig({ NODE_ENV: 'test' }), SATELLITE_PORT: 0 }
	const runtime = new MockRuntime({ config, logger })
	const server = new SatelliteServer({ config, logger, events: runtime.events() })
	runtime.start()
	await server.listen()
	started.push({ server, runtime })
	return { server, runtime, base: `ws://127.0.0.1:${server.address!.port}/ws/satellite` }
}

async function connect(url: string) {
	const client = new TestSatelliteClient({ url, pingIntervalMs: 0 })
	clients.push(client)
	await client.connect()
	await client.waitFor('BEGIN')
	return client
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close()
	for (const { server, runtime } of started.splice(0)) {
		runtime.stop()
		await server.close()
	}
})

describe('version selection', () => {
	it('advertises the latest version by default', async () => {
		const { base } = await startStack()
		const client = await connect(base)
		expect((await client.waitFor('BEGIN')).params.ApiVersion).toBe('1.14.0')
		await client.waitFor('CAPS')
	})

	it('advertises an older version when asked', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?api=1.9.0`)
		expect((await client.waitFor('BEGIN')).params.ApiVersion).toBe('1.9.0')
	})

	it('sends no CAPS line at all before 1.10', async () => {
		// Not an empty CAPS: a server of that vintage did not send one, and a client is documented to
		// infer feature existence from ApiVersion alone.
		const { base } = await startStack()
		const client = await connect(`${base}?api=1.9.0`)
		await new Promise((resolve) => setTimeout(resolve, 200))
		expect(client.messagesOf('CAPS')).toHaveLength(0)
	})

	it('falls back to the latest for an unknown version, rather than inventing one', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?api=99.0.0`)
		expect((await client.waitFor('BEGIN')).params.ApiVersion).toBe('1.14.0')
	})

	it('rejects commands the selected version predates', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?api=1.2.0`)
		await client.addDevice('dev1', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex' })

		client.sendMessage('KEY-ROTATE', { DEVICEID: 'dev1', KEY: 0, DIRECTION: 1 })
		const error = await client.waitFor('ERROR')
		expect(error.params.MESSAGE).toBe('Unknown command: KEY-ROTATE')
	})

	it('omits LOCATION from KEY-STATE before 1.10', async () => {
		const { base } = await startStack()

		const modern = await connect(base)
		await modern.addDevice('dev-new', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex' })
		await modern.waitForCount('KEY-STATE', 4)

		const legacy = await connect(`${base}?api=1.9.0`)
		await legacy.addDevice('dev-old', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex' })
		const oldStates = await legacy.waitForCount('KEY-STATE', 4)
		expect(oldStates.every((m) => m.params.LOCATION === undefined)).toBe(true)
	})

	it('omits TEXTCOLOR before 1.6 but still sends COLOR', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?api=1.5.1`)
		await client.addDevice('dev1', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex' })

		const states = await client.waitForCount('KEY-STATE', 4)
		expect(states.every((m) => m.params.TEXTCOLOR === undefined)).toBe(true)
		expect(states.some((m) => typeof m.params.COLOR === 'string')).toBe(true)
	})

	it('omits DEVICEID from responses before 1.2', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?api=1.1.0`)
		const added = await client.addDevice('dev1', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2 })
		expect(added.params.DEVICEID).toBeUndefined()
	})

	it('rejects subscriptions before 1.10', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?api=1.9.0`)
		client.sendMessage('ADD-SUB', { SUBID: 'a', LOCATION: '1/1/1' })
		const error = await client.waitFor('ERROR')
		expect(error.params.MESSAGE).toBe('Unknown command: ADD-SUB')
	})

	it('honours the subscriptions toggle on a version that supports them', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?subs=0`)
		expect((await client.waitFor('CAPS')).params.SUBSCRIPTIONS).toBe('0')

		client.sendMessage('ADD-SUB', { SUBID: 'a', LOCATION: '1/1/1' })
		expect((await client.waitFor('ADD-SUB')).params.MESSAGE).toBe('Subscriptions not enabled')
	})

	it('narrows the advertised bitmap formats, to exercise a client fallback', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?formats=rgb`)
		expect((await client.waitFor('CAPS')).params.BITMAP_FORMATS).toBe('rgb')
	})

	it('ignores an unknown format rather than advertising nothing', async () => {
		const { base } = await startStack()
		const client = await connect(`${base}?formats=jpeg`)
		expect((await client.waitFor('CAPS')).params.BITMAP_FORMATS).toBe('rgb,png,webp')
	})

	it('clamps rotation to a single step before 1.14', async () => {
		const { base, runtime } = await startStack()
		const client = await connect(`${base}?api=1.13.0`)
		await client.addDevice('dev1', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex', TEXT: 1 })
		await client.waitForCount('KEY-STATE', 4)
		runtime.selectScenario('dev1', 'input-echo')
		await client.waitForCount('KEY-STATE', 8)
		client.clearReceived()

		client.sendMessage('KEY-ROTATE', { DEVICEID: 'dev1', KEY: 0, DIRECTION: 7 })
		const states = await client.waitForCount('KEY-STATE', 1)
		const text = Buffer.from(String(states[0]!.params.TEXT ?? ''), 'base64').toString()
		// The magnitude is discarded: a 1.13 server had no way to express it.
		expect(text).toContain('+1')
		expect(text).not.toContain('+7')
	})
})
