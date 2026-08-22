import { describe, expect, it } from 'vitest'
import { ConnectionRegistry, normaliseIp, resolveClientIp, TokenBucket } from './limits.js'

/** A controllable clock — a rate limiter you can't test deterministically is one nobody trusts. */
function fakeClock(start = 1_000_000) {
	let now = start
	return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('TokenBucket', () => {
	it('allows a burst up to capacity then refuses', () => {
		const clock = fakeClock()
		const bucket = new TokenBucket(3, 1, clock.now)
		expect(bucket.take()).toBe(true)
		expect(bucket.take()).toBe(true)
		expect(bucket.take()).toBe(true)
		expect(bucket.take()).toBe(false)
	})

	it('refills at the configured rate', () => {
		const clock = fakeClock()
		const bucket = new TokenBucket(2, 10, clock.now)
		expect(bucket.take(2)).toBe(true)
		expect(bucket.take()).toBe(false)
		clock.advance(100) // 10/s → 1 token
		expect(bucket.take()).toBe(true)
	})

	it('never refills beyond capacity', () => {
		const clock = fakeClock()
		const bucket = new TokenBucket(2, 100, clock.now)
		clock.advance(60_000)
		expect(bucket.available).toBe(2)
	})

	it('does not partially consume when refusing', () => {
		const clock = fakeClock()
		const bucket = new TokenBucket(10, 1, clock.now)
		expect(bucket.take(20)).toBe(false)
		expect(bucket.available).toBe(10)
	})

	it('accommodates the reference client pinging at 10Hz for a minute', () => {
		// The spec suggests every 2s; the real client pings every 100ms. Limits tuned to the spec
		// would throttle every genuine client, so this is the case that matters.
		const clock = fakeClock()
		const bucket = new TokenBucket(200, 200, clock.now)
		for (let i = 0; i < 600; i++) {
			expect(bucket.take(), `ping ${i}`).toBe(true)
			clock.advance(100)
		}
	})

	it('rejects a nonsensical configuration', () => {
		expect(() => new TokenBucket(0, 1)).toThrow()
		expect(() => new TokenBucket(1, 0)).toThrow()
	})
})

describe('normaliseIp', () => {
	it('passes IPv4 through', () => {
		expect(normaliseIp('192.0.2.1')).toBe('192.0.2.1')
	})

	it('unwraps IPv4-mapped IPv6', () => {
		expect(normaliseIp('::ffff:192.0.2.1')).toBe('192.0.2.1')
	})

	it('buckets IPv6 by /64, so one subscriber is one bucket', () => {
		const a = normaliseIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
		const b = normaliseIp('2001:db8:1:2:1111:2222:3333:4444')
		expect(a).toBe(b)

		const other = normaliseIp('2001:db8:1:3:aaaa:bbbb:cccc:dddd')
		expect(other).not.toBe(a)
	})

	it('handles compressed IPv6 and zone ids', () => {
		expect(normaliseIp('2001:db8::1')).toBe(normaliseIp('2001:db8:0:0:0:0:0:2'))
		expect(normaliseIp('fe80::1%eth0')).toBe(normaliseIp('fe80::2'))
	})
})

describe('resolveClientIp', () => {
	it('ignores the header entirely when no proxies are trusted', () => {
		expect(resolveClientIp('10.0.0.1', '1.2.3.4', 0)).toBe('10.0.0.1')
	})

	it('takes the entry the trusted hop count points at', () => {
		// client → proxy2 → proxy1 → us. With one trusted hop, proxy1 appended "proxy2's peer",
		// which is the rightmost entry.
		expect(resolveClientIp('10.0.0.1', '9.9.9.9, 8.8.8.8', 1)).toBe('8.8.8.8')
		expect(resolveClientIp('10.0.0.1', '9.9.9.9, 8.8.8.8', 2)).toBe('9.9.9.9')
	})

	it('cannot be walked past the start of the chain by a client sending extra entries', () => {
		expect(resolveClientIp('10.0.0.1', '1.1.1.1', 3)).toBe('1.1.1.1')
	})

	it('falls back to the socket address for an empty or absent header', () => {
		expect(resolveClientIp('10.0.0.1', undefined, 1)).toBe('10.0.0.1')
		expect(resolveClientIp('10.0.0.1', '  ,  ', 1)).toBe('10.0.0.1')
		expect(resolveClientIp(undefined, undefined, 0)).toBe('0.0.0.0')
	})
})

describe('ConnectionRegistry', () => {
	const limits = { maxTotal: 4, maxPerIp: 2, perIpPerMinute: 60, burstPerIp: 3 }

	it('admits up to the per-ip limit', () => {
		const registry = new ConnectionRegistry(limits, fakeClock().now)
		expect(registry.admit('1.1.1.1').ok).toBe(true)
		expect(registry.admit('1.1.1.1').ok).toBe(true)
		expect(registry.admit('1.1.1.1')).toEqual({ ok: false, reason: 'too-many-for-ip' })
		expect(registry.admit('2.2.2.2').ok).toBe(true)
	})

	it('releases slots on disconnect', () => {
		const registry = new ConnectionRegistry(limits, fakeClock().now)
		registry.admit('1.1.1.1')
		registry.admit('1.1.1.1')
		registry.release('1.1.1.1')
		expect(registry.admit('1.1.1.1').ok).toBe(true)
	})

	it('enforces the global cap', () => {
		const registry = new ConnectionRegistry(limits, fakeClock().now)
		for (const ip of ['1.1.1.1', '1.1.1.1', '2.2.2.2', '2.2.2.2']) expect(registry.admit(ip).ok).toBe(true)
		expect(registry.admit('3.3.3.3')).toEqual({ ok: false, reason: 'server-full' })
	})

	it('rate limits reconnection storms', () => {
		const clock = fakeClock()
		const registry = new ConnectionRegistry(limits, clock.now)
		for (let i = 0; i < 3; i++) {
			expect(registry.admit('1.1.1.1').ok).toBe(true)
			registry.release('1.1.1.1')
		}
		expect(registry.admit('1.1.1.1')).toEqual({ ok: false, reason: 'connecting-too-fast' })
		clock.advance(1000) // 60/min → 1/s
		expect(registry.admit('1.1.1.1').ok).toBe(true)
	})

	it('does not spend a rate token on a connection refused for being over the concurrent limit', () => {
		// Otherwise a client sitting at its limit also accrues a rate-limit lockout it would have to
		// wait out after disconnecting, which turns a soft limit into a punitive one.
		const clock = fakeClock()
		const registry = new ConnectionRegistry({ ...limits, burstPerIp: 3 }, clock.now)
		registry.admit('1.1.1.1')
		registry.admit('1.1.1.1')
		for (let i = 0; i < 10; i++) expect(registry.admit('1.1.1.1').reason).toBe('too-many-for-ip')
		registry.release('1.1.1.1')
		expect(registry.admit('1.1.1.1').ok).toBe(true)
	})

	it('treats an IPv6 /64 as one client', () => {
		const registry = new ConnectionRegistry(limits, fakeClock().now)
		expect(registry.admit('2001:db8::1').ok).toBe(true)
		expect(registry.admit('2001:db8::2').ok).toBe(true)
		expect(registry.admit('2001:db8::3').reason).toBe('too-many-for-ip')
	})

	it('sweeps idle rate buckets so the map cannot grow forever', () => {
		const clock = fakeClock()
		const registry = new ConnectionRegistry(limits, clock.now)
		for (let i = 0; i < 50; i++) {
			registry.admit(`10.0.0.${i}`)
			registry.release(`10.0.0.${i}`)
		}
		expect(registry.trackedAddresses).toBe(50)
		clock.advance(60_000)
		expect(registry.sweep()).toBe(50)
		expect(registry.trackedAddresses).toBe(0)
	})

	it('does not sweep an address that still has a connection', () => {
		const clock = fakeClock()
		const registry = new ConnectionRegistry(limits, clock.now)
		registry.admit('1.1.1.1')
		clock.advance(60_000)
		registry.sweep()
		expect(registry.trackedAddresses).toBe(1)
	})
})
