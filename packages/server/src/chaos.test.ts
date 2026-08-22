import { describe, expect, it, vi } from 'vitest'
import { ChaosConfigSchema, ChaosConnection, DEFAULT_CHAOS, isChaosActive } from './chaos.js'
import type { SatelliteConnection } from './transport/types.js'

function fakeConnection(): SatelliteConnection & { frames: string[] } {
	const frames: string[] = []
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
		send: (line: string) => frames.push(line),
		destroy: () => {},
		frames,
	} as SatelliteConnection & { frames: string[] }
}

/** A deterministic "random", so probabilistic knobs are testable rather than flaky. */
const fixedRandom = (value: number) => () => value

describe('ChaosConfigSchema', () => {
	it('defaults to doing nothing', () => {
		expect(isChaosActive(DEFAULT_CHAOS)).toBe(false)
	})

	it('clamps every knob, so no tool can be turned into an amplifier', () => {
		expect(() => ChaosConfigSchema.parse({ latencyMs: 10_000 })).toThrow()
		expect(() => ChaosConfigSchema.parse({ dropRate: 5 })).toThrow()
		expect(() => ChaosConfigSchema.parse({ splitFrames: 5000 })).toThrow()
		expect(() => ChaosConfigSchema.parse({ coalesceMs: 60_000 })).toThrow()
	})
})

describe('ChaosConnection', () => {
	it('passes a line straight through when idle', () => {
		const inner = fakeConnection()
		new ChaosConnection(inner).send('PING x \n')
		expect(inner.frames).toEqual(['PING x \n'])
	})

	it('splits one line across many frames', () => {
		// The case that breaks a client assuming frame == message. Companion happens to write one
		// line per frame, so this never shows up in ordinary testing.
		const inner = fakeConnection()
		const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ splitFrames: 8 }))
		chaos.send('KEY-STATE DEVICEID="dev1" KEY=0 \n')

		expect(inner.frames.length).toBeGreaterThan(1)
		expect(inner.frames.join('')).toBe('KEY-STATE DEVICEID="dev1" KEY=0 \n')
	})

	it('splits down to roughly one byte per frame at the maximum', () => {
		const inner = fakeConnection()
		const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ splitFrames: 64 }))
		chaos.send('PING\n')
		expect(inner.frames.join('')).toBe('PING\n')
		expect(inner.frames.length).toBe(5)
	})

	it('coalesces several lines into one frame', () => {
		vi.useFakeTimers()
		try {
			const inner = fakeConnection()
			const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ coalesceMs: 50 }))
			chaos.send('A\n')
			chaos.send('B\n')
			chaos.send('C\n')
			expect(inner.frames).toHaveLength(0)

			vi.advanceTimersByTime(60)
			expect(inner.frames).toEqual(['A\nB\nC\n'])
		} finally {
			vi.useRealTimers()
		}
	})

	it('drops lines at the configured rate', () => {
		const inner = fakeConnection()
		const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ dropRate: 0.5 }), fixedRandom(0.1))
		chaos.send('A\n')
		expect(inner.frames).toHaveLength(0)
		expect(chaos.stats.dropped).toBe(1)

		const keeping = new ChaosConnection(inner, ChaosConfigSchema.parse({ dropRate: 0.5 }), fixedRandom(0.9))
		keeping.send('B\n')
		expect(inner.frames).toEqual(['B\n'])
	})

	it('duplicates lines at the configured rate', () => {
		const inner = fakeConnection()
		const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ duplicateRate: 1 }), fixedRandom(0))
		chaos.send('A\n')
		expect(inner.frames).toEqual(['A\n', 'A\n'])
	})

	it('delays a line by the configured latency', () => {
		vi.useFakeTimers()
		try {
			const inner = fakeConnection()
			const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ latencyMs: 200 }))
			chaos.send('A\n')
			expect(inner.frames).toHaveLength(0)

			vi.advanceTimersByTime(250)
			expect(inner.frames).toEqual(['A\n'])
		} finally {
			vi.useRealTimers()
		}
	})

	it("can remove Companion's trailing space", () => {
		const inner = fakeConnection()
		new ChaosConnection(inner, ChaosConfigSchema.parse({ trailingSpace: false })).send('KEYS-CLEAR KEY=0 \n')
		expect(inner.frames).toEqual(['KEYS-CLEAR KEY=0\n'])
	})

	it('can switch to CRLF', () => {
		const inner = fakeConnection()
		new ChaosConnection(inner, ChaosConfigSchema.parse({ crlf: true })).send('PING \n')
		expect(inner.frames).toEqual(['PING \r\n'])
	})

	it('combines the terminator knobs', () => {
		const inner = fakeConnection()
		new ChaosConnection(inner, ChaosConfigSchema.parse({ crlf: true, trailingSpace: false })).send('PING \n')
		expect(inner.frames).toEqual(['PING\r\n'])
	})

	it('flushes anything buffered when coalescing is turned off', () => {
		vi.useFakeTimers()
		try {
			const inner = fakeConnection()
			const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ coalesceMs: 1000 }))
			chaos.send('A\n')
			chaos.setConfig(DEFAULT_CHAOS)
			expect(inner.frames).toEqual(['A\n'])
		} finally {
			vi.useRealTimers()
		}
	})

	it('exposes swallowPings, which the session reads to stop answering keepalives', () => {
		// The knob cannot live in the wrapper's send path: pings are answered by the session, so a
		// wrapper that only rewrites outbound traffic would leave this control doing nothing at all.
		const chaos = new ChaosConnection(fakeConnection(), ChaosConfigSchema.parse({ swallowPings: true }))
		expect(chaos.swallowPings).toBe(true)
		chaos.setConfig(DEFAULT_CHAOS)
		expect(chaos.swallowPings).toBe(false)
	})

	it('sends nothing once the underlying connection has closed', () => {
		const inner = fakeConnection()
		Object.defineProperty(inner, 'closed', { value: true })
		const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ splitFrames: 4 }))
		chaos.send('A\n')
		expect(inner.frames).toHaveLength(0)
	})
})

describe('ChaosConnection close codes', () => {
	it('passes a close code through to the transport', () => {
		const inner = fakeConnection()
		const closes: [number, string | undefined][] = []
		inner.closeWith = (code, reason) => closes.push([code, reason])

		new ChaosConnection(inner, DEFAULT_CHAOS).closeWith(1013, 'blackout')

		expect(closes).toEqual([[1013, 'blackout']])
	})

	it('falls back to destroy on a transport with no concept of one', () => {
		const inner = fakeConnection()
		const destroy = vi.fn()
		inner.destroy = destroy

		new ChaosConnection(inner, DEFAULT_CHAOS).closeWith(1001)

		expect(destroy).toHaveBeenCalledOnce()
	})

	it('drops coalesced lines rather than delivering a batch after the close', () => {
		const inner = fakeConnection()
		inner.closeWith = () => {}
		const chaos = new ChaosConnection(inner, ChaosConfigSchema.parse({ coalesceMs: 500 }))

		chaos.send('KEY-STATE x\n')
		chaos.closeWith(1001)

		expect(inner.frames).toEqual([])
	})
})
