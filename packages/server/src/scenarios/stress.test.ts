import { pino } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import { buildSurface, capabilitiesFor, layoutFromLegacyParams, parseLineParameters } from '@satellite-mock/protocol'
import { StressParamsSchema, stressScenario } from './stress.js'
import { ScenarioEngine } from './engine.js'
import { SurfaceEmitter } from '../emitter.js'
import { RenderBudget } from '../render/budget.js'
import { ButtonRenderer } from '../render/renderer.js'
import type { Device } from '../devices.js'
import type { SatelliteConnection } from '../transport/types.js'

const logger = pino({ level: 'silent' })

function harness() {
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

	const layout = layoutFromLegacyParams(parseLineParameters('KEYS_TOTAL=8 KEYS_PER_ROW=4 COLORS=hex TEXT=1'))
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

	return { sent, device, emitter, engine: new ScenarioEngine(logger) }
}

describe('StressParamsSchema', () => {
	it('caps every dimension, so the tool cannot be turned into a flood', () => {
		expect(() => StressParamsSchema.parse({ fps: 1000 })).toThrow()
		expect(() => StressParamsSchema.parse({ durationSec: 3600 })).toThrow()
		expect(() => StressParamsSchema.parse({ controls: 100_000 })).toThrow()
	})

	it('has conservative defaults', () => {
		expect(StressParamsSchema.parse({})).toEqual({ fps: 10, durationSec: 20, controls: 32 })
	})
})

describe('stress scenario', () => {
	it('draws unique content each frame, so the render cache is not what is measured', () => {
		vi.useFakeTimers()
		try {
			const { engine, device, emitter, sent } = harness()
			engine.attach(device, emitter, stressScenario, { fps: 30, durationSec: 10 })

			for (let i = 0; i < 5; i++) {
				vi.advanceTimersByTime(40)
				engine.tickAll()
				emitter.flush()
			}

			const bodies = sent.filter((line) => line.startsWith('KEY-STATE'))
			expect(bodies.length).toBeGreaterThan(8)
			// Same control, different frames: the text carries the frame number, so nothing repeats.
			expect(new Set(bodies).size).toBe(bodies.length)
		} finally {
			vi.useRealTimers()
		}
	})

	it('stops itself when the duration is up', () => {
		vi.useFakeTimers()
		try {
			const { engine, device, emitter, sent } = harness()
			engine.attach(device, emitter, stressScenario, { fps: 10, durationSec: 1 })

			for (let i = 0; i < 40; i++) {
				vi.advanceTimersByTime(50)
				engine.tickAll()
			}
			emitter.flush()
			const before = sent.length

			for (let i = 0; i < 40; i++) {
				vi.advanceTimersByTime(50)
				engine.tickAll()
			}
			emitter.flush()

			// A load tool that runs until someone notices is a load tool that gets left running.
			expect(sent.length).toBe(before)
		} finally {
			vi.useRealTimers()
		}
	})

	it('honours the frame rate rather than drawing on every engine tick', () => {
		vi.useFakeTimers()
		try {
			const { engine, device, emitter } = harness()
			engine.attach(device, emitter, stressScenario, { fps: 1, durationSec: 10 })

			for (let i = 0; i < 10; i++) {
				vi.advanceTimersByTime(40)
				engine.tickAll()
			}

			// 400ms at 1fps is at most one frame beyond the initial one.
			expect((engine.get('dev1')!.context.state.get('frames') as number) ?? 0).toBeLessThanOrEqual(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it.each([10, 25, 30])('delivers the requested %i fps, evenly, on the engine resolution', (fps) => {
		// At the old 50ms engine resolution 30fps was impossible, and "at least 1/fps since the last
		// frame" lost a whole tick whenever the timer came in a millisecond early.
		vi.useFakeTimers()
		try {
			const { engine, device, emitter } = harness()
			engine.attach(device, emitter, stressScenario, { fps, durationSec: 10 })

			for (let elapsed = 0; elapsed < 2000; elapsed += ScenarioEngine.TICK_RESOLUTION_MS) {
				// Real timers wobble; alternate a millisecond early and late.
				vi.advanceTimersByTime(ScenarioEngine.TICK_RESOLUTION_MS + (elapsed % 20 === 0 ? -1 : 1))
				engine.tickAll()
			}

			const frames = engine.get('dev1')!.context.state.get('frames') as number
			expect(frames).toBeGreaterThanOrEqual(fps * 2 - 1)
			expect(frames).toBeLessThanOrEqual(fps * 2 + 1)
		} finally {
			vi.useRealTimers()
		}
	})
})
