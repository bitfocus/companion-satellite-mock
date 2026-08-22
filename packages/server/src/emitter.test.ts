import { capabilitiesFor, buildSurface, layoutFromLegacyParams, parseLineParameters } from '@satellite-mock/protocol'
import { describe, expect, it } from 'vitest'
import { formatColor, SurfaceEmitter } from './emitter.js'
import type { Device } from './devices.js'
import { RenderBudget } from './render/budget.js'
import { ButtonRenderer } from './render/renderer.js'
import type { SatelliteConnection } from './transport/types.js'

const caps = capabilitiesFor('1.14.0')

/** A connection that just records what was sent. */
function fakeConnection(bufferedAmount = 0): SatelliteConnection & { sentLines: string[] } {
	const sentLines: string[] = []
	return {
		id: 'test',
		kind: 'ws',
		remoteAddress: '127.0.0.1',
		bytesReceived: 0,
		bytesSent: 0,
		messagesReceived: 0,
		messagesSent: 0,
		openedAt: Date.now(),
		closed: false,
		bufferedAmount,
		send: (line: string) => sentLines.push(line.trimEnd()),
		destroy: () => {},
		sentLines,
	} as SatelliteConnection & { sentLines: string[] }
}

function makeDevice(addLine: string, overrides: Partial<Device> = {}): Device {
	const layout = layoutFromLegacyParams(parseLineParameters(addLine))
	if (typeof layout === 'string') throw new Error(layout)
	return {
		id: 'dev1',
		serial: 'dev1',
		serialIsUnique: true,
		productName: 'Test',
		connection: fakeConnection(),
		surface: buildSurface(layout, false),
		bitmapFormat: 'rgb',
		supportsBrightness: true,
		supportsLockedState: false,
		canChangePage: undefined,
		variables: [],
		configFields: undefined,
		addedAt: Date.now(),
		firmwareUpdateUrl: null,
		...overrides,
	}
}

function makeEmitter(addLine = 'KEYS_TOTAL=4 KEYS_PER_ROW=2 COLORS=hex TEXT=1', deviceOverrides: Partial<Device> = {}) {
	const connection = fakeConnection()
	const device = makeDevice(addLine, { connection, ...deviceOverrides })
	const emitter = new SurfaceEmitter({
		device,
		connection,
		capabilities: caps,
		renderer: new ButtonRenderer(),
		budget: new RenderBudget(100_000_000),
	})
	return { emitter, connection, device }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('SurfaceEmitter', () => {
	it('sends a KEY-STATE with the negotiated fields', async () => {
		const { emitter, connection } = makeEmitter()
		emitter.draw('0/0', { bgColor: '#112233', text: 'HI' })
		await tick()

		expect(connection.sentLines).toHaveLength(1)
		const line = connection.sentLines[0]!
		expect(line).toContain('KEY-STATE DEVICEID="dev1" KEY=0')
		expect(line).toContain('COLOR="#112233"')
		expect(line).toContain('TEXT="SEk="')
	})

	it('coalesces repeated draws of one control into a single message', async () => {
		// Without this, a 30fps scenario on a slow link builds a backlog of frames nobody sees.
		const { emitter, connection } = makeEmitter()
		emitter.draw('0/0', { text: 'a' })
		emitter.draw('0/0', { text: 'b' })
		emitter.draw('0/0', { text: 'c' })
		await tick()

		expect(connection.sentLines).toHaveLength(1)
		expect(connection.sentLines[0]).toContain(Buffer.from('c').toString('base64'))
		expect(emitter.stats.coalesced).toBe(2)
	})

	it('merges a partial update onto the current style', async () => {
		const { emitter, connection } = makeEmitter()
		emitter.draw('0/0', { bgColor: '#ff0000', text: 'keep' })
		await tick()
		connection.sentLines.length = 0

		emitter.draw('0/0', { pressed: true })
		await tick()
		expect(connection.sentLines[0]).toContain('COLOR="#ff0000"')
		expect(connection.sentLines[0]).toContain(Buffer.from('keep').toString('base64'))
		expect(connection.sentLines[0]).toContain('PRESSED=1')
	})

	it('sends one message per control for a full-surface draw', async () => {
		const { emitter, connection } = makeEmitter()
		emitter.drawAll({ bgColor: '#000000' })
		await tick()
		expect(connection.sentLines).toHaveLength(4)
	})

	it('ignores a draw for a control that does not exist', async () => {
		const { emitter, connection } = makeEmitter()
		emitter.draw('99/99', { text: 'nope' })
		await tick()
		expect(connection.sentLines).toHaveLength(0)
	})

	it('uses CONTROLID on an advanced surface', async () => {
		const connection = fakeConnection()
		const device = makeDevice('KEYS_TOTAL=1', { connection })
		const advanced: Device = {
			...device,
			surface: buildSurface(
				{ stylePresets: { default: { colors: 'hex' } }, controls: { 'enc/0': { row: 0, column: 0 } } },
				true
			),
		}
		const emitter = new SurfaceEmitter({
			device: advanced,
			connection,
			capabilities: caps,
			renderer: new ButtonRenderer(),
			budget: new RenderBudget(100_000_000),
		})

		emitter.draw('enc/0', { bgColor: '#00ff00' })
		await tick()
		expect(connection.sentLines[0]).toContain('CONTROLID="enc/0"')
		expect(connection.sentLines[0]).not.toContain('KEY=')
	})

	it('includes a bitmap only when the preset asked for one', async () => {
		const withBitmap = makeEmitter('KEYS_TOTAL=1 BITMAPS=8')
		withBitmap.emitter.draw('0/0', { bgColor: '#000000' })
		await tick()
		expect(withBitmap.connection.sentLines[0]).toContain('BITMAP=')

		const without = makeEmitter('KEYS_TOTAL=1 COLORS=hex')
		without.emitter.draw('0/0', { bgColor: '#000000' })
		await tick()
		expect(without.connection.sentLines[0]).not.toContain('BITMAP=')
	})

	it('drops the bitmap but keeps the message when over the render budget', async () => {
		// A surface that cannot keep up should skip frames, not disconnect — and colour and text are
		// cheap, so they keep flowing and the surface stays responsive.
		const connection = fakeConnection()
		const device = makeDevice('KEYS_TOTAL=1 BITMAPS=64 COLORS=hex', { connection })
		const emitter = new SurfaceEmitter({
			device,
			connection,
			capabilities: caps,
			renderer: new ButtonRenderer(),
			budget: new RenderBudget(1),
		})

		emitter.draw('0/0', { bgColor: '#123456' })
		await tick()
		expect(connection.sentLines[0]).not.toContain('BITMAP=')
		expect(connection.sentLines[0]).toContain('COLOR="#123456"')
	})

	it('drops the queue and reports overflow when the socket is backed up', async () => {
		let overflowed = false
		const connection = fakeConnection(10 * 1024 * 1024)
		const device = makeDevice('KEYS_TOTAL=4 KEYS_PER_ROW=2', { connection })
		const emitter = new SurfaceEmitter({
			device,
			connection,
			capabilities: caps,
			renderer: new ButtonRenderer(),
			budget: new RenderBudget(100_000_000),
			maxQueuedBytes: 1024,
			onOverflow: () => (overflowed = true),
		})

		emitter.drawAll({ bgColor: '#000000' })
		await tick()
		expect(overflowed).toBe(true)
		expect(connection.sentLines).toHaveLength(0)
	})

	it('honours the brightness opt-out', () => {
		const on = makeEmitter('KEYS_TOTAL=1')
		on.emitter.setBrightness(50)
		expect(on.connection.sentLines[0]).toBe('BRIGHTNESS DEVICEID="dev1" VALUE=50')

		const off = makeEmitter('KEYS_TOTAL=1', { supportsBrightness: false })
		off.emitter.setBrightness(50)
		expect(off.connection.sentLines).toHaveLength(0)
	})

	it('clamps brightness to 0-100', () => {
		const { emitter, connection } = makeEmitter('KEYS_TOTAL=1')
		emitter.setBrightness(500)
		emitter.setBrightness(-20)
		expect(connection.sentLines).toEqual([
			'BRIGHTNESS DEVICEID="dev1" VALUE=100',
			'BRIGHTNESS DEVICEID="dev1" VALUE=0',
		])
	})

	it('sends LOCKED-STATE only to a device that asked to handle it', () => {
		const off = makeEmitter('KEYS_TOTAL=1')
		off.emitter.setLocked(true, 2)
		expect(off.connection.sentLines).toHaveLength(0)

		const on = makeEmitter('KEYS_TOTAL=1', { supportsLockedState: 'FULL' })
		on.emitter.setLocked(true, 2, 90)
		expect(on.connection.sentLines[0]).toBe('LOCKED-STATE DEVICEID="dev1" LOCKED=1 CHARACTER_COUNT=2 ROTATION=90')
	})

	it('streams only variables the client declared as outputs', () => {
		const { emitter, connection } = makeEmitter('KEYS_TOTAL=1', {
			variables: [
				{ id: 'out', type: 'output', name: 'Out' },
				{ id: 'in', type: 'input', name: 'In' },
			],
		})

		emitter.sendVariable('out', 'value')
		emitter.sendVariable('in', 'value')
		emitter.sendVariable('unknown', 'value')

		expect(connection.sentLines).toHaveLength(1)
		expect(connection.sentLines[0]).toContain('VARIABLE="out"')
	})

	it('sends DEVICE-CONFIG only when the client declared config fields', () => {
		const without = makeEmitter('KEYS_TOTAL=1')
		without.emitter.sendDeviceConfig({ a: 1 })
		expect(without.connection.sentLines).toHaveLength(0)

		const withFields = makeEmitter('KEYS_TOTAL=1', {
			configFields: [{ id: 'a', label: 'A', type: 'checkbox' }],
		})
		withFields.emitter.sendDeviceConfig({ a: true })
		expect(withFields.connection.sentLines[0]).toContain('CONFIG=')
	})

	it('clears pending draws on KEYS-CLEAR, so a stale frame cannot arrive after it', async () => {
		const { emitter, connection } = makeEmitter()
		emitter.draw('0/0', { text: 'stale' })
		emitter.clearKeys()
		await tick()

		expect(connection.sentLines).toEqual(['KEYS-CLEAR DEVICEID="dev1"'])
	})

	it('emits LEDS when the preset declares them', async () => {
		const connection = fakeConnection()
		const device = makeDevice('KEYS_TOTAL=1', { connection })
		const withLeds: Device = {
			...device,
			surface: buildSurface(
				{
					stylePresets: { default: { colors: 'hex', leds: { segments: 4, mode: 'simple' } } },
					controls: { 'enc/0': { row: 0, column: 0 } },
				},
				true
			),
		}
		const emitter = new SurfaceEmitter({
			device: withLeds,
			connection,
			capabilities: caps,
			renderer: new ButtonRenderer(),
			budget: new RenderBudget(100_000_000),
		})

		emitter.draw('enc/0', { gauge: 0.5 })
		await tick()
		const match = /LEDS="([^"]+)"/.exec(connection.sentLines[0]!)
		expect(match).not.toBeNull()
		expect(Buffer.from(match![1]!, 'base64')).toHaveLength(4 * 3)
	})
})

describe('formatColor', () => {
	it('passes hex through and converts rgb without spaces', () => {
		expect(formatColor('#00ff00', 'hex')).toBe('#00ff00')
		expect(formatColor('#00ff00', 'rgb')).toBe('rgb(0,255,0)')
		expect(formatColor('#123456', 'rgb')).toBe('rgb(18,52,86)')
	})
})
