import { TestSatelliteClient } from '@satellite-mock/testclient'
import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { MockRuntime } from './runtime.js'
import { SatelliteServer } from './satelliteServer.js'
import { appRouter, type TrpcContext } from './web/trpc.js'

/**
 * Subscriptions, end to end.
 *
 * They are connection-scoped and reference an absolute page/row/column rather than any surface, so
 * they cannot be driven by a scenario the way a device can. `SubscriptionPages` owns the content at
 * each location and pushes SUB-STATE to everyone watching it.
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
	return { server, runtime, url: `ws://127.0.0.1:${server.address!.port}/ws/satellite` }
}

async function connect(url: string) {
	const client = new TestSatelliteClient({ url, pingIntervalMs: 0 })
	clients.push(client)
	await client.connect()
	await client.waitFor('CAPS')
	return client
}

const decode = (value: string | true | undefined) =>
	typeof value === 'string' ? Buffer.from(value, 'base64').toString() : ''

afterEach(async () => {
	for (const client of clients.splice(0)) client.close()
	for (const { server, runtime } of started.splice(0)) {
		runtime.stop()
		await server.close()
	}
})

describe('subscription content', () => {
	it("pushes a location's current content on subscribe", async () => {
		const { url, runtime } = await startStack()
		runtime.setPageContent('1/2/3', { text: 'PRESET', bgColor: '#123456' })

		const client = await connect(url)
		client.sendMessage('ADD-SUB', { SUBID: 'a', LOCATION: '1/2/3', COLORS: 'hex', TEXT: 1 })

		// Exactly one, carrying the real content. An earlier version sent a blank state and then a
		// second with the content, which is both wasteful and a race for a client that renders on
		// first receipt.
		const states = await client.waitForCount('SUB-STATE', 1, 5000)
		expect(states).toHaveLength(1)
		expect(decode(states[0]!.params.TEXT)).toBe('PRESET')
		expect(states[0]!.params.COLOR).toBe('#123456')
	})

	it('streams an update when the location changes', async () => {
		const { url, runtime } = await startStack()
		const client = await connect(url)
		client.sendMessage('ADD-SUB', { SUBID: 'a', LOCATION: '1/1/1', COLORS: 'hex', TEXT: 1 })
		await client.waitForCount('SUB-STATE', 1)
		client.clearReceived()

		expect(runtime.setPageContent('1/1/1', { text: 'CHANGED' })).toBe(1)
		const states = await client.waitForCount('SUB-STATE', 1)
		expect(decode(states[0]!.params.TEXT)).toBe('CHANGED')
	})

	it('does not notify a subscription watching a different location', async () => {
		const { url, runtime } = await startStack()
		const client = await connect(url)
		client.sendMessage('ADD-SUB', { SUBID: 'a', LOCATION: '1/1/1', TEXT: 1 })
		await client.waitForCount('SUB-STATE', 1)
		client.clearReceived()

		expect(runtime.setPageContent('9/9/9', { text: 'ELSEWHERE' })).toBe(0)
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(client.messagesOf('SUB-STATE')).toHaveLength(0)
	})

	it('reaches every subscription watching a location, across connections', async () => {
		const { url, runtime } = await startStack()
		const first = await connect(url)
		const second = await connect(url)

		first.sendMessage('ADD-SUB', { SUBID: 'a', LOCATION: '2/0/0', TEXT: 1 })
		second.sendMessage('ADD-SUB', { SUBID: 'b', LOCATION: '2/0/0', TEXT: 1 })
		await first.waitForCount('SUB-STATE', 1)
		await second.waitForCount('SUB-STATE', 1)
		first.clearReceived()
		second.clearReceived()

		expect(runtime.setPageContent('2/0/0', { text: 'BOTH' })).toBe(2)
		expect(decode((await first.waitForCount('SUB-STATE', 1))[0]!.params.TEXT)).toBe('BOTH')
		expect(decode((await second.waitForCount('SUB-STATE', 1))[0]!.params.TEXT)).toBe('BOTH')
	})

	it('stops notifying after REMOVE-SUB', async () => {
		const { url, runtime } = await startStack()
		const client = await connect(url)
		client.sendMessage('ADD-SUB', { SUBID: 'a', LOCATION: '1/1/1', TEXT: 1 })
		await client.waitForCount('SUB-STATE', 1)

		client.sendMessage('REMOVE-SUB', { SUBID: 'a' })
		await client.waitFor('REMOVE-SUB')
		expect(runtime.setPageContent('1/1/1', { text: 'GONE' })).toBe(0)
	})

	it('fills in blank values rather than omitting them for an empty location', async () => {
		// A client that asked for colours and receives a SUB-STATE carrying none may reasonably leave
		// the button as it was, so an empty location must still say what empty looks like.
		const { url } = await startStack()
		const client = await connect(url)
		client.sendMessage('ADD-SUB', { SUBID: 'a', LOCATION: '5/5/5', COLORS: 'hex', TEXT: 1 })

		const states = await client.waitForCount('SUB-STATE', 1)
		expect(states[0]!.params.COLOR).toBe('#000000')
		expect(states[0]!.params.TEXT).toBeDefined()
	})

	it('honours what each subscription asked for', async () => {
		const { url, runtime } = await startStack()
		runtime.setPageContent('1/0/0', { text: 'HELLO', bgColor: '#00ff00' })

		const client = await connect(url)
		client.sendMessage('ADD-SUB', { SUBID: 'text-only', LOCATION: '1/0/0', TEXT: 1 })
		client.sendMessage('ADD-SUB', { SUBID: 'colour-only', LOCATION: '1/0/0', COLORS: 'hex' })
		await client.waitForCount('SUB-STATE', 2, 5000)

		const textOnly = client
			.messagesOf('SUB-STATE')
			.filter((m) => m.params.SUBID === 'text-only')
			.at(-1)!
		const colourOnly = client
			.messagesOf('SUB-STATE')
			.filter((m) => m.params.SUBID === 'colour-only')
			.at(-1)!

		expect(decode(textOnly.params.TEXT)).toBe('HELLO')
		expect(textOnly.params.COLOR).toBeUndefined()
		expect(colourOnly.params.COLOR).toBe('#00ff00')
		expect(colourOnly.params.TEXT).toBeUndefined()
	})
})

describe('the subscriptions API', () => {
	it("lists a connection's subscriptions and validates a location", async () => {
		const { url, server, runtime } = await startStack()
		const client = await connect(url)
		await client.addDevice('dev1', { KEYS_TOTAL: 4, KEYS_PER_ROW: 2, COLORS: 'hex' })
		await client.waitForCount('KEY-STATE', 4)

		const owner = appRouter.createCaller({
			runtime,
			satellite: server,
			uiClientId: 'owner',
			clientIp: '203.0.113.1',
		} satisfies TrpcContext)
		const { sessionId } = await owner.claim({ code: runtime.sessions.all()[0]!.claimCode })

		client.sendMessage('ADD-SUB', { SUBID: 'watch/1', LOCATION: '3/1/2', COLORS: 'hex', TEXT: 1 })
		await client.waitForCount('SUB-STATE', 1)

		const listed = await owner.subscriptions({ sessionId })
		expect(listed).toHaveLength(1)
		expect(listed[0]).toMatchObject({ subId: 'watch/1', location: '3/1/2' })

		await expect(owner.setPageContent({ sessionId, location: 'nonsense', text: 'x' })).rejects.toThrow()
		await expect(
			owner.setPageContent({ sessionId, location: '3/1/2', text: 'via api', bgColor: '#ff0000' })
		).resolves.toEqual({ notified: 1 })
	})
})
