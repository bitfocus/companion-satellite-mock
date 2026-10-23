import { randomUUID } from 'node:crypto'
import { claimCodeMatches, generateClaimCode } from './claimCode.js'
import type { Device } from './devices.js'
import type { SatelliteSession } from './satelliteSession.js'
import { AddressBuckets, TokenBucket, type Clock } from './limits.js'

/** One line of the protocol trace, with payloads already elided. */
export interface TraceEntry {
	at: number
	direction: 'in' | 'out'
	line: string
}

export type MockSessionState = 'unclaimed' | 'claimed' | 'offline'

/**
 * Prepare a line for display in the trace.
 *
 * Two things: the terminator and Companion's trailing space are stripped, because they are noise in
 * a list of lines and nobody is debugging whitespace here; and a bitmap payload is replaced with its
 * size, because 20KB of base64 per line makes the trace unreadable and unbounded in the browser.
 */
export function formatForTrace(line: string): string {
	return line
		.replace(/\r?\n$/, '')
		.replace(/\s+$/, '')
		.replace(/BITMAP="?([^" ]{64,})"?/, (_match, payload: string) => `BITMAP=<${payload.length} chars>`)
}

/**
 * A UI-facing session: everything the operator controls for one connected client.
 *
 * Keyed for continuity by the *primary device id* — the first device the connection registers — so
 * a client that drops and reconnects lands back in the same session with its scenario, settings and
 * claim intact. That requires the client to keep a stable DEVICEID across reconnects; one that
 * mints a fresh id per launch gets a new session and a new claim code every time.
 */
export class MockSession {
	readonly id = randomUUID()
	readonly createdAt: number

	claimCode: string
	/** The browser holding this session, by its opaque UI client id. */
	claimedBy: string | undefined
	/** Live subscribers in the web UI. A session with a watcher is never garbage collected. */
	watchers = new Set<string>()

	connection: SatelliteSession | undefined
	primaryDeviceId: string | undefined
	disconnectedAt: number | undefined
	/**
	 * The address of the most recent connection, kept after it goes away.
	 *
	 * The reconnect blackout has to be readable precisely when there is no connection to read it
	 * from — that is the state it exists to create — so the address outlives the socket.
	 */
	lastRemoteAddress: string | undefined

	readonly trace: TraceEntry[] = []

	/**
	 * Keepalives are counted, not traced.
	 *
	 * The reference client pings at 10Hz, so recording them would evict every useful line from a
	 * bounded ring buffer within seconds — filtering them out in the UI does not help, because by
	 * then the real traffic is already gone. What a client author actually wants from a ping is
	 * whether it is arriving and how often, which a counter answers better than 20 identical lines
	 * a second.
	 */
	keepalivesIn = 0
	keepalivesOut = 0
	lastKeepaliveAt: number | undefined

	constructor(
		private readonly maxTrace: number,
		private readonly now: Clock = Date.now
	) {
		this.createdAt = now()
		this.claimCode = generateClaimCode()
	}

	get state(): MockSessionState {
		if (!this.connection) return 'offline'
		return this.claimedBy ? 'claimed' : 'unclaimed'
	}

	/** Append to the trace ring buffer, which is fixed-size so a chatty client cannot grow it. */
	record(direction: 'in' | 'out', rawLine: string): void {
		const line = formatForTrace(rawLine)
		const command = line.split(' ')[0]?.toUpperCase()
		if (command === 'PING' || command === 'PONG') {
			if (direction === 'in') this.keepalivesIn++
			else this.keepalivesOut++
			this.lastKeepaliveAt = this.now()
			return
		}

		this.trace.push({ at: this.now(), direction, line })
		if (this.trace.length > this.maxTrace) this.trace.splice(0, this.trace.length - this.maxTrace)
	}

	claim(uiClientId: string): void {
		this.claimedBy = uiClientId
	}

	/** Release the session and mint a fresh code, so the old one cannot be reused. */
	unclaim(): void {
		this.claimedBy = undefined
		this.watchers.clear()
		this.claimCode = generateClaimCode()
	}

	/**
	 * Whether this session may be collected.
	 *
	 * The window starts only once *both* ends are gone: the client has disconnected and no browser
	 * is watching. An operator with the tab open keeps a crashed client's session — with its claim,
	 * settings and trace — which is the behaviour you want mid-debugging. The absolute lifetime is
	 * what stops a forgotten tab holding one open indefinitely.
	 */
	isCollectable(graceMs: number, maxLifetimeMs: number): boolean {
		if (this.now() - this.createdAt > maxLifetimeMs) return true
		if (this.connection) return false
		if (this.watchers.size > 0) return false
		return this.disconnectedAt !== undefined && this.now() - this.disconnectedAt > graceMs
	}
}

export interface SessionManagerOptions {
	graceMs: number
	maxLifetimeMs: number
	maxTrace?: number
	maxSessionsPerUiClient?: number
	/** Per client address (IPv6 by /64), successes included. */
	claimAttemptsPerMinute?: number
	/** Server-wide, failures only. The ceiling on guessing that holds however many addresses a guesser has. */
	claimFailuresPerMinute?: number
	now?: Clock
}

export type ClaimResult =
	| { ok: true; session: MockSession }
	| { ok: false; reason: 'not-found' | 'rate-limited' | 'busy' | 'too-many-sessions' }

/**
 * Owns every session, and the claim-code lookup.
 *
 * Claiming is the one place a stranger can act on someone else's session, and a valid code takes a
 * session over even if it is already claimed. So guessing is limited twice: per client address,
 * never per UI client id — that id is chosen by the browser, and a limit keyed on it is bypassed by
 * sending a new one each time — and server-wide on failures, which is what bounds a guesser holding
 * many addresses. At the default 120 failures a minute against 32^6 codes, a guesser running flat
 * out for a day has about a 1-in-6000 chance per live session of hitting one. The cost is that
 * enough addresses guessing together can lock out claiming for everyone until they stop; for a test
 * server that is the right way round. The code comparison is constant time.
 */
export class SessionManager {
	readonly #sessions = new Map<string, MockSession>()
	/** Continuity index: primary device id → session. */
	readonly #byPrimaryDevice = new Map<string, MockSession>()
	readonly #claimBuckets: AddressBuckets
	readonly #claimFailures: TokenBucket
	/**
	 * Reverse index from live connection to session.
	 *
	 * The trace hook runs for every line, and the reference client pings at 10Hz — scanning every
	 * session per line would be quadratic in connection count on the hottest path there is.
	 */
	readonly #byConnection = new WeakMap<SatelliteSession, MockSession>()

	readonly #graceMs: number
	readonly #maxLifetimeMs: number
	readonly #maxTrace: number
	readonly #maxPerUiClient: number
	readonly #now: Clock

	constructor(options: SessionManagerOptions) {
		this.#graceMs = options.graceMs
		this.#maxLifetimeMs = options.maxLifetimeMs
		this.#maxTrace = options.maxTrace ?? 2000
		this.#maxPerUiClient = options.maxSessionsPerUiClient ?? 4
		this.#now = options.now ?? Date.now
		const perAddress = options.claimAttemptsPerMinute ?? 10
		this.#claimBuckets = new AddressBuckets(perAddress, perAddress / 60, 10_000, this.#now)
		const failures = options.claimFailuresPerMinute ?? 120
		this.#claimFailures = new TokenBucket(failures, failures / 60, this.#now)
	}

	get size(): number {
		return this.#sessions.size
	}

	all(): MockSession[] {
		return [...this.#sessions.values()]
	}

	get(id: string): MockSession | undefined {
		return this.#sessions.get(id)
	}

	create(): MockSession {
		const session = new MockSession(this.#maxTrace, this.#now)
		this.#sessions.set(session.id, session)
		return session
	}

	/**
	 * Bind a connection to a session, reusing the existing one when the primary device id is known.
	 *
	 * This is what makes a reconnect invisible to the operator — and why the claim survives a client
	 * crash, a network flap, or the deliberate bounce the version selector performs.
	 */
	attach(connection: SatelliteSession, primaryDeviceId: string): MockSession {
		const existing = this.#byPrimaryDevice.get(primaryDeviceId)
		if (existing) {
			existing.connection = connection
			existing.disconnectedAt = undefined
			existing.lastRemoteAddress = connection.connection.remoteAddress
			this.#byConnection.set(connection, existing)
			return existing
		}

		const session = this.create()
		session.primaryDeviceId = primaryDeviceId
		session.connection = connection
		session.lastRemoteAddress = connection.connection.remoteAddress
		this.#byPrimaryDevice.set(primaryDeviceId, session)
		this.#byConnection.set(connection, session)
		return session
	}

	detach(session: MockSession): void {
		if (session.connection) this.#byConnection.delete(session.connection)
		session.connection = undefined
		session.disconnectedAt = this.#now()
	}

	/** O(1) lookup for the trace hook, which runs on every line in and out. */
	forConnection(connection: SatelliteSession): MockSession | undefined {
		return this.#byConnection.get(connection)
	}

	/** Look up by claim code, rate limited by `clientIp` (see the class comment). Constant-time per candidate. */
	claim(code: string, uiClientId: string, clientIp: string): ClaimResult {
		if (!this.#claimBuckets.take(clientIp)) return { ok: false, reason: 'rate-limited' }
		if (this.#claimFailures.available < 1) return { ok: false, reason: 'busy' }

		const held = this.all().filter((session) => session.claimedBy === uiClientId).length
		if (held >= this.#maxPerUiClient) return { ok: false, reason: 'too-many-sessions' }

		for (const session of this.#sessions.values()) {
			if (claimCodeMatches(code, session.claimCode)) {
				session.claim(uiClientId)
				return { ok: true, session }
			}
		}
		this.#claimFailures.take()
		return { ok: false, reason: 'not-found' }
	}

	/** Collect sessions nobody is using. Returns how many were removed. */
	sweep(): number {
		let removed = 0
		for (const [id, session] of this.#sessions) {
			if (session.isCollectable(this.#graceMs, this.#maxLifetimeMs)) {
				this.#sessions.delete(id)
				if (session.primaryDeviceId) this.#byPrimaryDevice.delete(session.primaryDeviceId)
				removed++
			}
		}
		return removed
	}

	/** Called when a device registers, so the session picks up its continuity key. */
	noteDevice(session: MockSession, device: Device): void {
		if (session.primaryDeviceId) return
		session.primaryDeviceId = device.id
		this.#byPrimaryDevice.set(device.id, session)
	}
}
