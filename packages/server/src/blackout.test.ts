import { describe, expect, it } from 'vitest'
import { MAX_BLACKOUT_MS, ReconnectBlackout } from './blackout.js'

/** A clock the test drives, so nothing here depends on wall time. */
function fakeClock(start = 1_000_000) {
	let now = start
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms
		},
	}
}

describe('ReconnectBlackout', () => {
	it('blocks an address for the requested duration and then stops', () => {
		const clock = fakeClock()
		const blackout = new ReconnectBlackout(clock.now)

		blackout.add('10.0.0.1', 5000)
		expect(blackout.blocks('10.0.0.1')).toBe(true)

		clock.advance(4999)
		expect(blackout.blocks('10.0.0.1')).toBe(true)

		clock.advance(1)
		expect(blackout.blocks('10.0.0.1')).toBe(false)
	})

	it('leaves other addresses alone', () => {
		const blackout = new ReconnectBlackout(fakeClock().now)
		blackout.add('10.0.0.1', 5000)

		expect(blackout.blocks('10.0.0.2')).toBe(false)
	})

	it('caps the duration however long is asked for', () => {
		const clock = fakeClock()
		const blackout = new ReconnectBlackout(clock.now)

		blackout.add('10.0.0.1', 24 * 60 * 60 * 1000)

		clock.advance(MAX_BLACKOUT_MS)
		expect(blackout.blocks('10.0.0.1')).toBe(false)
	})

	it('extends rather than shortens on an overlapping call', () => {
		const clock = fakeClock()
		const blackout = new ReconnectBlackout(clock.now)

		blackout.add('10.0.0.1', 10_000)
		// A shorter second call must not become a way to cancel the first.
		blackout.add('10.0.0.1', 1000)

		clock.advance(5000)
		expect(blackout.blocks('10.0.0.1')).toBe(true)
	})

	it('clears on request', () => {
		const blackout = new ReconnectBlackout(fakeClock().now)
		blackout.add('10.0.0.1', 30_000)

		blackout.clear('10.0.0.1')
		expect(blackout.blocks('10.0.0.1')).toBe(false)
	})

	it('treats an IPv6 /64 as one client, so a new address is not an escape', () => {
		const blackout = new ReconnectBlackout(fakeClock().now)
		blackout.add('2001:db8:1:2:aaaa:bbbb:cccc:dddd', 30_000)

		expect(blackout.blocks('2001:db8:1:2:1111:2222:3333:4444')).toBe(true)
		expect(blackout.blocks('2001:db8:1:3:aaaa:bbbb:cccc:dddd')).toBe(false)
	})

	it('reports how long is left', () => {
		const clock = fakeClock()
		const blackout = new ReconnectBlackout(clock.now)
		blackout.add('10.0.0.1', 10_000)

		clock.advance(3000)
		expect(blackout.state('10.0.0.1')?.remainingMs).toBe(7000)

		clock.advance(8000)
		expect(blackout.state('10.0.0.1')).toBeUndefined()
	})

	it('a zero duration is a no-op rather than a permanent block', () => {
		const blackout = new ReconnectBlackout(fakeClock().now)
		blackout.add('10.0.0.1', 0)

		expect(blackout.blocks('10.0.0.1')).toBe(false)
	})

	it('does not grow without bound', () => {
		const clock = fakeClock()
		const blackout = new ReconnectBlackout(clock.now)

		for (let i = 0; i < 50; i++) blackout.add(`10.0.0.${i}`, 1000)
		expect(blackout.size).toBe(50)

		clock.advance(2000)
		expect(blackout.sweep()).toBe(50)
		expect(blackout.size).toBe(0)
	})

	it('expired entries are dropped as they are read, not only on sweep', () => {
		const clock = fakeClock()
		const blackout = new ReconnectBlackout(clock.now)
		blackout.add('10.0.0.1', 1000)

		clock.advance(2000)
		blackout.blocks('10.0.0.1')
		expect(blackout.size).toBe(0)
	})
})
