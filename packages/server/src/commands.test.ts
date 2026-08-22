import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { pino } from 'pino'
import { loadConfig, type Config } from './config.js'
import { SatelliteServer } from './satelliteServer.js'
import type { SatelliteEvents } from './events.js'

/**
 * Command-level tests, driven over a real socket.
 *
 * The point of these is fidelity: a client author debugging against the mock must be told about the
 * *same* problem Companion would report, in the same words, or they chase a different bug than the
 * one they have. So these assert on exact error strings and on validation order.
 */

const logger = pino({ level: 'silent' })
const servers: SatelliteServer[] = []
const sockets: WebSocket[] = []

interface Client {
	socket: WebSocket
	lines: string[]
	send(line: string): void
	waitFor(match: string | RegExp, timeoutMs?: number): Promise<string>
	/** Wait until `count` lines match — `waitFor` alone resolves on one already in the buffer. */
	waitForCount(match: string | RegExp, count: number, timeoutMs?: number): Promise<void>
	/** Every line received so far, so a test can assert something did NOT arrive. */
	readonly received: string[]
}

async function startServer(
	overrides: Partial<Config> = {},
	options: { events?: SatelliteEvents; subscriptionsEnabled?: boolean } = {}
): Promise<{ server: SatelliteServer; url: string }> {
	const config = { ...loadConfig({ NODE_ENV: 'test' }), SATELLITE_PORT: 0, ...overrides }
	const server = new SatelliteServer({ config, logger, ...options })
	await server.listen()
	servers.push(server)
	return { server, url: `ws://127.0.0.1:${server.address!.port}/ws/satellite` }
}

async function connect(url: string): Promise<Client> {
	const socket = new WebSocket(url)
	sockets.push(socket)
	const lines: string[] = []
	socket.on('message', (data) => {
		for (const line of data.toString().split('\n')) if (line.length > 0) lines.push(line.trimEnd())
	})
	await new Promise<void>((resolve, reject) => {
		socket.once('open', () => resolve())
		socket.once('error', reject)
	})

	const client: Client = {
		socket,
		lines,
		received: lines,
		send: (line) => socket.send(line.endsWith('\n') ? line : `${line}\n`),
		async waitFor(match, timeoutMs = 2000) {
			const test = (l: string) => (typeof match === 'string' ? l.startsWith(match) : match.test(l))
			const deadline = Date.now() + timeoutMs
			for (;;) {
				const found = lines.find(test)
				if (found) return found
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${match}; got:\n${lines.join('\n')}`)
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
		},
		async waitForCount(match, count, timeoutMs = 2000) {
			const test = (l: string) => (typeof match === 'string' ? l.startsWith(match) : match.test(l))
			const deadline = Date.now() + timeoutMs
			for (;;) {
				if (lines.filter(test).length >= count) return
				if (Date.now() > deadline) {
					throw new Error(`timed out waiting for ${count}x ${match}; got:\n${lines.join('\n')}`)
				}
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
		},
	}
	await client.waitFor('BEGIN')
	return client
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close()
	for (const server of servers.splice(0)) await server.close()
})

const ADD = 'ADD-DEVICE DEVICEID=dev1 PRODUCT_NAME="Test Surface"'

describe('ADD-DEVICE', () => {
	it('registers a legacy surface', async () => {
		const { url, server } = await startServer()
		const client = await connect(url)
		client.send(ADD)
		expect(await client.waitFor('ADD-DEVICE')).toBe('ADD-DEVICE OK DEVICEID="dev1"')

		const device = server.devices.get('dev1')
		expect(device?.productName).toBe('Test Surface')
		expect(device?.surface.gridSize).toEqual({ rows: 4, columns: 8 })
		expect(device?.surface.fromManifest).toBe(false)
	})

	it.each([
		['ADD-DEVICE', 'ADD-DEVICE ERROR MESSAGE="Missing DEVICEID"'],
		['ADD-DEVICE DEVICEID=dev1', 'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Missing PRODUCT_NAME"'],
		[
			'ADD-DEVICE DEVICEID=emulator:1 PRODUCT_NAME=x',
			'ADD-DEVICE ERROR DEVICEID="emulator:1" MESSAGE="Reserved DEVICEID"',
		],
		[
			'ADD-DEVICE DEVICEID=dev1 PRODUCT_NAME=x SERIAL=group:1',
			'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Reserved SERIAL"',
		],
		[
			'ADD-DEVICE DEVICEID=dev1 PRODUCT_NAME=x KEYS_TOTAL=0',
			'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Invalid KEYS_TOTAL"',
		],
		[
			'ADD-DEVICE DEVICEID=dev1 PRODUCT_NAME=x KEYS_PER_ROW=99999',
			'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Invalid KEYS_PER_ROW"',
		],
		[
			'ADD-DEVICE DEVICEID=dev1 PRODUCT_NAME=x LAYOUT_MANIFEST=bm90anNvbg==',
			'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Invalid LAYOUT_MANIFEST"',
		],
		[
			'ADD-DEVICE DEVICEID=dev1 PRODUCT_NAME=x VARIABLES=bm90anNvbg==',
			'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Invalid VARIABLES"',
		],
		[
			'ADD-DEVICE DEVICEID=dev1 PRODUCT_NAME=x CONFIG_FIELDS=bm90anNvbg==',
			'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Invalid CONFIG_FIELDS"',
		],
	])('rejects %s', async (send, expected) => {
		const { url } = await startServer()
		const client = await connect(url)
		client.send(send)
		expect(await client.waitFor('ADD-DEVICE')).toBe(expected)
	})

	it('accepts a reserved DEVICEID when a clean SERIAL is supplied', async () => {
		// Upstream checks only the resolved serial, so this passes. Reproduced deliberately: a client
		// relying on it would otherwise work against Companion and fail against the mock.
		const { url } = await startServer()
		const client = await connect(url)
		client.send('ADD-DEVICE DEVICEID=emulator:1 PRODUCT_NAME=x SERIAL=streamdeck:123')
		expect(await client.waitFor('ADD-DEVICE')).toBe('ADD-DEVICE OK DEVICEID="emulator:1"')
	})

	it('rejects a second registration of the same id on the same connection', async () => {
		const { url } = await startServer()
		const client = await connect(url)
		client.send(ADD)
		await client.waitFor('ADD-DEVICE OK')
		client.lines.length = 0
		client.send(ADD)
		expect(await client.waitFor('ADD-DEVICE')).toBe(
			'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Device already added"'
		)
	})

	it('tells the EXISTING connection when another claims its device id, and the new one nothing', async () => {
		const { url } = await startServer()
		const first = await connect(url)
		first.send(ADD)
		await first.waitFor('ADD-DEVICE OK')
		first.lines.length = 0

		const second = await connect(url)
		second.lines.length = 0
		second.send(ADD)

		expect(await first.waitFor('ADD-DEVICE')).toBe(
			'ADD-DEVICE ERROR DEVICEID="dev1" MESSAGE="Device exists elsewhere"'
		)
		await settle()
		expect(second.received.filter((l) => l.startsWith('ADD-DEVICE'))).toEqual([])
	})

	it('registers an advanced surface from a layout manifest', async () => {
		const { url, server } = await startServer()
		const client = await connect(url)
		const manifest = Buffer.from(
			JSON.stringify({
				stylePresets: { default: { colors: 'hex' }, enc: { colors: 'rgb' } },
				controls: { '0/0': { row: 0, column: 0 }, 'enc/0': { row: 1, column: 3, stylePreset: 'enc' } },
			})
		).toString('base64')
		client.send(`ADD-DEVICE DEVICEID=dev1 PRODUCT_NAME=x LAYOUT_MANIFEST=${manifest}`)
		await client.waitFor('ADD-DEVICE OK')

		const device = server.devices.get('dev1')!
		expect(device.surface.fromManifest).toBe(true)
		expect(device.surface.gridSize).toEqual({ rows: 2, columns: 4 })
		expect(device.surface.controls.get('enc/0')!.style.colors).toBe('rgb')
	})

	it('negotiates the bitmap format, falling back to rgb for anything unadvertised', async () => {
		const { url, server } = await startServer()
		const client = await connect(url)
		client.send(`${ADD} BITMAP_FORMAT=webp`)
		await client.waitFor('ADD-DEVICE OK')
		expect(server.devices.get('dev1')!.bitmapFormat).toBe('webp')

		client.send('ADD-DEVICE DEVICEID=dev2 PRODUCT_NAME=x BITMAP_FORMAT=jpeg')
		await client.waitFor('ADD-DEVICE OK DEVICEID="dev2"')
		expect(server.devices.get('dev2')!.bitmapFormat).toBe('rgb')
	})

	it('rejects an oversized bitmap rather than silently clamping it', async () => {
		const { url } = await startServer()
		const client = await connect(url)
		client.send(`${ADD} BITMAPS=4096`)
		expect(await client.waitFor('ADD-DEVICE')).toContain('Bitmap too large')
	})

	it('caps devices per connection', async () => {
		const { url } = await startServer()
		const client = await connect(url)
		for (let i = 0; i < 4; i++) client.send(`ADD-DEVICE DEVICEID=dev${i} PRODUCT_NAME=x`)
		await client.waitForCount('ADD-DEVICE OK', 4)
		client.send('ADD-DEVICE DEVICEID=dev9 PRODUCT_NAME=x')
		expect(await client.waitFor(/ADD-DEVICE ERROR DEVICEID="dev9"/)).toContain('Too many devices')
	})

	it('releases devices when the connection closes, freeing the id for another client', async () => {
		const { url, server } = await startServer()
		const first = await connect(url)
		first.send(ADD)
		await first.waitFor('ADD-DEVICE OK')
		expect(server.devices.size).toBe(1)

		first.socket.close()
		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(server.devices.size).toBe(0)

		const second = await connect(url)
		second.send(ADD)
		expect(await second.waitFor('ADD-DEVICE')).toBe('ADD-DEVICE OK DEVICEID="dev1"')
	})
})

describe('input commands', () => {
	async function withDevice(extra = '') {
		const events: { presses: [string, boolean][]; rotates: [string, number][] } = { presses: [], rotates: [] }
		const { url, server } = await startServer(
			{},
			{
				events: {
					onKeyPress: (_s, _d, controlId, pressed) => events.presses.push([controlId, pressed]),
					onKeyRotate: (_s, _d, controlId, delta) => events.rotates.push([controlId, delta]),
				},
			}
		)
		const client = await connect(url)
		client.send(`${ADD} ${extra}`)
		await client.waitFor('ADD-DEVICE OK')
		client.lines.length = 0
		return { client, server, events }
	}

	it('accepts a flat key index and resolves it to a control', async () => {
		const { client, events } = await withDevice()
		client.send('KEY-PRESS DEVICEID=dev1 KEY=9 PRESSED=1')
		expect(await client.waitFor('KEY-PRESS')).toBe('KEY-PRESS OK DEVICEID="dev1"')
		expect(events.presses).toEqual([['1/1', true]])
	})

	it('accepts row/column notation for the same control', async () => {
		const { client, events } = await withDevice()
		client.send('KEY-PRESS DEVICEID=dev1 KEY=1/1 PRESSED=true')
		await client.waitFor('KEY-PRESS OK')
		expect(events.presses).toEqual([['1/1', true]])
	})

	it('treats PRESSED=0 as a release, not as a missing parameter', async () => {
		const { client, events } = await withDevice()
		client.send('KEY-PRESS DEVICEID=dev1 KEY=0 PRESSED=0')
		await client.waitFor('KEY-PRESS OK')
		expect(events.presses).toEqual([['0/0', false]])
	})

	it.each([
		[
			'KEY-PRESS',
			'KEY-PRESS DEVICEID=nope KEY=0 PRESSED=1',
			'KEY-PRESS ERROR DEVICEID="nope" MESSAGE="Device not found"',
		],
		['KEY-PRESS', 'KEY-PRESS KEY=0 PRESSED=1', 'KEY-PRESS ERROR MESSAGE="Missing DEVICEID"'],
		['KEY-PRESS', 'KEY-PRESS DEVICEID=dev1 PRESSED=1', 'KEY-PRESS ERROR DEVICEID="dev1" MESSAGE="Missing KEY"'],
		[
			'KEY-PRESS',
			'KEY-PRESS DEVICEID=dev1 KEY= PRESSED=1',
			'KEY-PRESS ERROR DEVICEID="dev1" MESSAGE="Missing KEY"',
		],
		[
			'KEY-PRESS',
			'KEY-PRESS DEVICEID=dev1 KEY=99 PRESSED=1',
			'KEY-PRESS ERROR DEVICEID="dev1" MESSAGE="Invalid KEY"',
		],
		['KEY-PRESS', 'KEY-PRESS DEVICEID=dev1 KEY=0', 'KEY-PRESS ERROR DEVICEID="dev1" MESSAGE="Missing PRESSED"'],
		[
			'KEY-ROTATE',
			'KEY-ROTATE DEVICEID=dev1 KEY=0',
			'KEY-ROTATE ERROR DEVICEID="dev1" MESSAGE="Missing DIRECTION"',
		],
	])('%s error: %s', async (prefix, send, expected) => {
		const { client } = await withDevice()
		client.send(send)
		expect(await client.waitFor(prefix)).toBe(expected)
	})

	it('carries the rotation magnitude at 1.14', async () => {
		const { client, events } = await withDevice()
		client.send('KEY-ROTATE DEVICEID=dev1 KEY=0 DIRECTION=5')
		client.send('KEY-ROTATE DEVICEID=dev1 KEY=0 DIRECTION=-3')
		client.send('KEY-ROTATE DEVICEID=dev1 KEY=0 DIRECTION=0')
		await client.waitForCount('KEY-ROTATE OK', 3)
		expect(events.rotates).toEqual([
			['0/0', 5],
			['0/0', -3],
			['0/0', -1],
		])
	})

	it('requires CONTROLID on an advanced surface and rejects an unknown one', async () => {
		const manifest = Buffer.from(
			JSON.stringify({ stylePresets: { default: {} }, controls: { 'a/1': { row: 0, column: 0 } } })
		).toString('base64')
		const { client } = await withDevice(`LAYOUT_MANIFEST=${manifest}`)

		client.send('KEY-PRESS DEVICEID=dev1 KEY=0 PRESSED=1')
		expect(await client.waitFor('KEY-PRESS')).toBe('KEY-PRESS ERROR DEVICEID="dev1" MESSAGE="Missing CONTROLID"')
		client.lines.length = 0

		client.send('KEY-PRESS DEVICEID=dev1 CONTROLID=nope PRESSED=1')
		expect(await client.waitFor('KEY-PRESS')).toBe('KEY-PRESS ERROR DEVICEID="dev1" MESSAGE="Unknown CONTROLID"')
	})

	it('validates a pincode digit', async () => {
		const { client } = await withDevice()
		client.send('PINCODE-KEY DEVICEID=dev1 KEY=7')
		expect(await client.waitFor('PINCODE-KEY')).toBe('PINCODE-KEY OK DEVICEID="dev1"')
		client.lines.length = 0
		client.send('PINCODE-KEY DEVICEID=dev1 KEY=10')
		expect(await client.waitFor('PINCODE-KEY')).toBe('PINCODE-KEY ERROR DEVICEID="dev1" MESSAGE="Invalid KEY"')
	})

	it('echoes the variable name on SET-VARIABLE-VALUE and decodes the payload', async () => {
		let received: [string, string] | undefined
		const { url } = await startServer({}, { events: { onVariableValue: (_s, _d, k, v) => (received = [k, v]) } })
		const client = await connect(url)
		client.send(ADD)
		await client.waitFor('ADD-DEVICE OK')

		client.send('SET-VARIABLE-VALUE DEVICEID=dev1 VARIABLE="my-var" VALUE="aGVsbG8gd29ybGQ="')
		expect(await client.waitFor('SET-VARIABLE-VALUE')).toBe(
			'SET-VARIABLE-VALUE OK DEVICEID="dev1" VARIABLE="my-var"'
		)
		expect(received).toEqual(['my-var', 'hello world'])
	})

	it('stores a firmware update url as inert text and never fetches it', async () => {
		let reported: string | null | undefined
		const { url, server } = await startServer(
			{},
			{ events: { onFirmwareUpdateInfo: (_s, _d, u) => (reported = u) } }
		)
		const client = await connect(url)
		client.send(ADD)
		await client.waitFor('ADD-DEVICE OK')

		client.send('FIRMWARE-UPDATE-INFO DEVICEID=dev1 UPDATE_URL="http://127.0.0.1:1/should-never-be-fetched"')
		expect(await client.waitFor('FIRMWARE-UPDATE-INFO')).toBe('FIRMWARE-UPDATE-INFO OK DEVICEID="dev1"')
		expect(reported).toBe('http://127.0.0.1:1/should-never-be-fetched')
		expect(server.devices.get('dev1')!.firmwareUpdateUrl).toBe('http://127.0.0.1:1/should-never-be-fetched')

		client.lines.length = 0
		client.send('FIRMWARE-UPDATE-INFO DEVICEID=dev1 UPDATE_URL=""')
		await client.waitFor('FIRMWARE-UPDATE-INFO OK')
		expect(server.devices.get('dev1')!.firmwareUpdateUrl).toBeNull()
	})
})

describe('subscriptions', () => {
	it('subscribes, pushes initial state, and unsubscribes', async () => {
		const { url } = await startServer()
		const client = await connect(url)

		client.send('ADD-SUB SUBID=my/sub LOCATION=1/2/3 COLORS=hex')
		expect(await client.waitFor('ADD-SUB')).toBe('ADD-SUB OK SUBID="my/sub"')
		expect(await client.waitFor('SUB-STATE')).toContain('SUBID="my/sub"')

		client.send('REMOVE-SUB SUBID=my/sub')
		expect(await client.waitFor('REMOVE-SUB')).toBe('REMOVE-SUB OK SUBID="my/sub"')
	})

	it.each([
		['ADD-SUB LOCATION=1/2/3', 'ADD-SUB ERROR MESSAGE="Missing SUBID"'],
		['ADD-SUB SUBID="bad id" LOCATION=1/2/3', 'ADD-SUB ERROR MESSAGE="Invalid SUBID"'],
		['ADD-SUB SUBID=a', 'ADD-SUB ERROR MESSAGE="Missing LOCATION"'],
		['ADD-SUB SUBID=a LOCATION=nope', 'ADD-SUB ERROR MESSAGE="Invalid LOCATION"'],
		['REMOVE-SUB SUBID=nope', 'REMOVE-SUB ERROR MESSAGE="Unknown SUBID"'],
		['SUB-PRESS SUBID=nope PRESSED=1', 'SUB-PRESS ERROR MESSAGE="Unknown SUBID"'],
	])('rejects %s', async (send, expected) => {
		const { url } = await startServer()
		const client = await connect(url)
		client.send(send)
		expect(await client.waitFor(send.split(' ')[0]!)).toBe(expected)
	})

	it('rejects a duplicate SUBID', async () => {
		const { url } = await startServer()
		const client = await connect(url)
		client.send('ADD-SUB SUBID=a LOCATION=1/1/1')
		await client.waitFor('ADD-SUB OK')
		client.lines.length = 0
		client.send('ADD-SUB SUBID=a LOCATION=1/1/1')
		expect(await client.waitFor('ADD-SUB')).toBe('ADD-SUB ERROR MESSAGE="SUBID already in use"')
	})

	it('reports Subscriptions not enabled when the operator has turned them off', async () => {
		const { url } = await startServer({}, { subscriptionsEnabled: false })
		const client = await connect(url)
		expect(client.received.find((l) => l.startsWith('CAPS'))).toContain('SUBSCRIPTIONS=0')

		client.send('ADD-SUB SUBID=a LOCATION=1/1/1')
		expect(await client.waitFor('ADD-SUB')).toBe('ADD-SUB ERROR MESSAGE="Subscriptions not enabled"')
	})
})
