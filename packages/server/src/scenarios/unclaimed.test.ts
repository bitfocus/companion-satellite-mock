import { buildSurface, capabilitiesFor, layoutFromLegacyParams, parseLineParameters } from '@satellite-mock/protocol'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { unclaimedScenario } from './builtin.js'
import { ScenarioEngine } from './engine.js'
import { SurfaceEmitter } from '../emitter.js'
import { RenderBudget } from '../render/budget.js'
import { ButtonRenderer } from '../render/renderer.js'
import type { Device } from '../devices.js'
import type { SatelliteConnection } from '../transport/types.js'

/**
 * The Unclaimed screen is the one thing that must work on every surface.
 *
 * It is what an evaluator sees, and the only route into the web UI — a code that is
 * truncated, overwritten or missing makes the session unclaimable. An earlier version placed the
 * server-URL button at `length - 2` *after* laying out the code, so on an 8-key surface it
 * overwrote the sixth character and rendered a five-character code. Manual testing never caught it
 * because it was always done on a 32-key surface.
 */

const logger = pino({ level: 'silent' })
const CODE = 'K7M2QP'

function renderOn(keysTotal: number, keysPerRow: number): { texts: string[]; sent: string[] } {
	const sent: string[] = []
	const connection = {
		id: 'c',
		kind: 'ws',
		remoteAddress: '127.0.0.1',
		bytesReceived: 0,
		bytesSent: 0,
		messagesReceived: 0,
		messagesSent: 0,
		openedAt: Date.now(),
		closed: false,
		send: (line: string) => sent.push(line),
		destroy: () => {},
	} as SatelliteConnection

	const layout = layoutFromLegacyParams(
		parseLineParameters(`KEYS_TOTAL=${keysTotal} KEYS_PER_ROW=${keysPerRow} COLORS=hex TEXT=1`)
	)
	if (typeof layout === 'string') throw new Error(layout)

	const device: Device = {
		id: 'dev1',
		serial: 'dev1',
		serialIsUnique: true,
		productName: 'Test',
		connection,
		surface: buildSurface(layout, false),
		bitmapFormat: 'rgb',
		supportsBrightness: true,
		supportsLockedState: false,
		canChangePage: undefined,
		variables: [],
		configFields: undefined,
		addedAt: Date.now(),
		firmwareUpdateUrl: null,
	}

	const emitter = new SurfaceEmitter({
		device,
		connection,
		capabilities: capabilitiesFor('1.14.0'),
		renderer: new ButtonRenderer(),
		budget: new RenderBudget(1_000_000_000),
	})

	new ScenarioEngine(logger).attach(device, emitter, unclaimedScenario(CODE, 'mock.test'))
	emitter.flush()

	const texts = sent
		.map((line) => /TEXT="([^"]*)"/.exec(line)?.[1])
		.filter((value): value is string => value !== undefined)
		.map((value) => Buffer.from(value, 'base64').toString())

	return { texts, sent }
}

/** The code as a reader would assemble it: single-character keys in order. */
const codeFrom = (texts: string[]) => texts.filter((text) => text.length === 1).join('')

describe('the Unclaimed screen', () => {
	// Deliberately spans tiny surfaces up to large ones. The bug lived at exactly 8 keys, which is a
	// perfectly ordinary size and was not covered by anything.
	it.each([
		[4, 2],
		[6, 3],
		[8, 4],
		[9, 3],
		[12, 4],
		[15, 5],
		[32, 8],
		[64, 8],
	])('shows a complete, claimable code on a %i-key surface', (keysTotal, keysPerRow) => {
		const { texts } = renderOn(keysTotal, keysPerRow)
		const joined = texts.join(' ')

		const spelled = codeFrom(texts)
		const wholeOnOneKey = texts.includes(CODE) || texts.includes('K7M-2QP')

		expect(
			spelled === CODE || wholeOnOneKey,
			`surface ${keysTotal}x${keysPerRow} rendered "${spelled}" and texts ${JSON.stringify(texts)}`
		).toBe(true)
		expect(joined.replace(/-?\n/g, '')).toContain('UNCLAIMED')
	})

	it('never draws two things onto the same control', () => {
		// The failure mode was an overlap, so assert directly that each control is drawn once.
		const { sent } = renderOn(8, 4)
		const keys = sent.map((line) => /KEY=(\d+)/.exec(line)?.[1]).filter(Boolean)
		expect(new Set(keys).size).toBe(keys.length)
	})

	it('drops the optional extras rather than the code when space is tight', () => {
		// Seven keys: header plus six code characters, and nothing left over.
		const { texts } = renderOn(7, 7)
		expect(codeFrom(texts)).toBe(CODE)
		expect(texts.join(' ')).not.toContain('mock.test')
	})

	it('falls back to the whole code on one key when it cannot be spelled out', () => {
		const { texts } = renderOn(4, 2)
		expect(texts.some((text) => text.includes('K7M') || text === CODE)).toBe(true)
	})

	it('still works on a single-key surface', () => {
		expect(() => renderOn(1, 1)).not.toThrow()
	})
})
