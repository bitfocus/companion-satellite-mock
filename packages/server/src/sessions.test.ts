import { describe, expect, it } from 'vitest'
import { SessionManager } from './sessions.js'

function fakeClock(start = 1_000_000) {
	let now = start
	return { now: () => now, advance: (ms: number) => (now += ms) }
}

const GRACE = 10 * 60 * 1000
const LIFETIME = 12 * 60 * 60 * 1000

function makeManager(clock = fakeClock()) {
	return {
		clock,
		manager: new SessionManager({ graceMs: GRACE, maxLifetimeMs: LIFETIME, now: clock.now }),
	}
}

/** A stand-in for a live connection — the manager only ever checks whether one is present. */
const fakeConnection = () => ({}) as never

describe('SessionManager claiming', () => {
	it('claims by code', () => {
		const { manager } = makeManager()
		const session = manager.create()
		expect(manager.claim(session.claimCode, 'browser-1')).toEqual({ ok: true, session })
		expect(session.state).toBe('offline') // no connection attached in this test
		expect(session.claimedBy).toBe('browser-1')
	})

	it('rejects an unknown code', () => {
		const { manager } = makeManager()
		manager.create()
		expect(manager.claim('ZZZZZZ', 'browser-1')).toEqual({ ok: false, reason: 'not-found' })
	})

	it('rate limits attempts, which is what makes a six-character code sufficient', () => {
		const { manager, clock } = makeManager()
		manager.create()
		for (let i = 0; i < 5; i++) expect(manager.claim('ZZZZZZ', 'browser-1').reason).toBe('not-found')
		expect(manager.claim('ZZZZZZ', 'browser-1')).toEqual({ ok: false, reason: 'rate-limited' })

		clock.advance(60_000)
		expect(manager.claim('ZZZZZZ', 'browser-1').reason).toBe('not-found')
	})

	it('rate limits per browser, so one attacker cannot lock everyone else out', () => {
		const { manager } = makeManager()
		manager.create()
		for (let i = 0; i < 6; i++) manager.claim('ZZZZZZ', 'attacker')
		expect(manager.claim('ZZZZZZ', 'attacker').reason).toBe('rate-limited')
		expect(manager.claim('ZZZZZZ', 'someone-else').reason).toBe('not-found')
	})

	it('caps how many sessions one browser may hold', () => {
		const { manager } = makeManager()
		const sessions = Array.from({ length: 5 }, () => manager.create())
		for (let i = 0; i < 4; i++) expect(manager.claim(sessions[i]!.claimCode, 'browser-1').ok).toBe(true)
		expect(manager.claim(sessions[4]!.claimCode, 'browser-1')).toEqual({ ok: false, reason: 'too-many-sessions' })
	})

	it('mints a fresh code on unclaim, so the old one cannot be reused', () => {
		const { manager } = makeManager()
		const session = manager.create()
		const original = session.claimCode
		manager.claim(original, 'browser-1')
		session.unclaim()

		expect(session.claimCode).not.toBe(original)
		expect(manager.claim(original, 'browser-2').reason).toBe('not-found')
		expect(manager.claim(session.claimCode, 'browser-2').ok).toBe(true)
	})
})

describe('SessionManager continuity', () => {
	it('reuses the session when a client reconnects with the same primary device id', () => {
		const { manager } = makeManager()
		const first = manager.attach(fakeConnection(), 'streamdeck:123')
		manager.claim(first.claimCode, 'browser-1')
		const code = first.claimCode

		manager.detach(first)
		const second = manager.attach(fakeConnection(), 'streamdeck:123')

		expect(second).toBe(first)
		expect(second.claimedBy).toBe('browser-1')
		expect(second.claimCode).toBe(code)
		expect(manager.size).toBe(1)
	})

	it('creates a new session for a client that mints a fresh device id each launch', () => {
		// Worth pinning because it is the failure mode a client author will actually hit: a new id
		// per launch means a new session and a new claim code every time.
		const { manager } = makeManager()
		manager.attach(fakeConnection(), 'random:1')
		manager.attach(fakeConnection(), 'random:2')
		expect(manager.size).toBe(2)
	})
})

describe('SessionManager sweeping', () => {
	it('keeps a disconnected session for the grace window', () => {
		const { manager, clock } = makeManager()
		const session = manager.attach(fakeConnection(), 'dev1')
		manager.detach(session)

		clock.advance(GRACE - 1000)
		expect(manager.sweep()).toBe(0)
		clock.advance(2000)
		expect(manager.sweep()).toBe(1)
	})

	it('never collects a session with a live connection', () => {
		const { manager, clock } = makeManager()
		manager.attach(fakeConnection(), 'dev1')
		clock.advance(GRACE * 10)
		expect(manager.sweep()).toBe(0)
	})

	it('keeps a disconnected session alive while a browser is watching', () => {
		// The behaviour that matters mid-debugging: the app crashes, the tab stays open, and the
		// claim, settings and trace survive.
		const { manager, clock } = makeManager()
		const session = manager.attach(fakeConnection(), 'dev1')
		session.watchers.add('browser-1')
		manager.detach(session)

		clock.advance(GRACE * 5)
		expect(manager.sweep()).toBe(0)

		session.watchers.delete('browser-1')
		clock.advance(GRACE + 1000)
		expect(manager.sweep()).toBe(1)
	})

	it('collects even a watched session once the absolute lifetime is up', () => {
		// Otherwise a forgotten tab holds a session open forever.
		const { manager, clock } = makeManager()
		const session = manager.attach(fakeConnection(), 'dev1')
		session.watchers.add('browser-1')
		clock.advance(LIFETIME + 1000)
		expect(manager.sweep()).toBe(1)
	})

	it('frees the device id so a later client starts fresh', () => {
		const { manager, clock } = makeManager()
		const first = manager.attach(fakeConnection(), 'dev1')
		const code = first.claimCode
		manager.detach(first)
		clock.advance(GRACE + 1000)
		manager.sweep()

		const second = manager.attach(fakeConnection(), 'dev1')
		expect(second).not.toBe(first)
		expect(second.claimCode).not.toBe(code)
	})
})

describe('MockSession trace', () => {
	it('is a fixed-size ring buffer, so a chatty client cannot grow it', () => {
		const clock = fakeClock()
		const manager = new SessionManager({ graceMs: GRACE, maxLifetimeMs: LIFETIME, maxTrace: 10, now: clock.now })
		const session = manager.create()
		for (let i = 0; i < 100; i++) session.record('in', `PING ${i}`)

		expect(session.trace).toHaveLength(10)
		expect(session.trace[0]!.line).toBe('PING 90')
		expect(session.trace.at(-1)!.line).toBe('PING 99')
	})
})
