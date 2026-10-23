import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { KNOWN_API_VERSIONS } from '@satellite-mock/protocol'
import { BUILTIN_SCENARIOS } from '../scenarios/builtin.js'
import type { MockRuntime } from '../runtime.js'
import { isSafeValue } from '@satellite-mock/protocol'
import { AddressBuckets } from '../limits.js'
import { ChaosConfigSchema, DEFAULT_CHAOS } from '../chaos.js'
import { MAX_BLACKOUT_MS } from '../blackout.js'
import type { SatelliteServer } from '../satelliteServer.js'

export interface TrpcContext {
	runtime: MockRuntime
	/** Needed to reach a connection's chaos wrapper, which lives with the transport. */
	satellite: SatelliteServer
	/** Opaque per-browser id, from localStorage. Not a credential — it scopes, it does not authorise. */
	uiClientId: string
	/**
	 * The browser's address, resolved through TRUSTED_PROXY_HOPS. What rate limits key on, because
	 * `uiClientId` is whatever the browser says it is and a limit keyed on it is no limit at all.
	 */
	clientIp: string
}

const t = initTRPC.context<TrpcContext>().create()

/**
 * Mutations are rate limited per client address.
 *
 * The UI is public and unauthenticated, so every mutation is reachable by anyone. The claim flow has
 * its own stricter limiter in SessionManager; this is the blanket one that stops a script driving
 * scenario switches or raw sends in a tight loop.
 */
const mutationBuckets = new AddressBuckets(60, 10)

const rateLimited = t.middleware(({ ctx, next }) => {
	if (!mutationBuckets.take(ctx.clientIp)) {
		throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Slow down' })
	}
	return next()
})

const publicProcedure = t.procedure
const mutation = t.procedure.use(rateLimited)

/**
 * Require that this browser holds the session.
 *
 * Session contents are explicitly not confidential (see docs/design.md §9), but *acting* on someone
 * else's session should still need the claim code they were given.
 */
function requireClaimed(ctx: TrpcContext, sessionId: string) {
	const session = ctx.runtime.sessions.get(sessionId)
	if (!session) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such session' })
	if (session.claimedBy !== ctx.uiClientId) {
		throw new TRPCError({ code: 'FORBIDDEN', message: 'This session is not claimed by you' })
	}
	return session
}

const sessionIdInput = z.object({ sessionId: z.string().uuid() })

function sessionSnapshot(runtime: MockRuntime, sessionId: string) {
	const session = runtime.sessions.get(sessionId)
	if (!session) return null

	const deviceId = session.primaryDeviceId
	const deviceRuntime = deviceId ? runtime.runtimeFor(deviceId) : undefined
	const device = deviceRuntime?.device
	const running = deviceId ? runtime.scenarios.get(deviceId) : undefined

	return {
		id: session.id,
		state: session.state,
		claimCode: session.claimCode,
		createdAt: session.createdAt,
		device: device
			? {
					id: device.id,
					serial: device.serial,
					productName: device.productName,
					gridSize: device.surface.gridSize,
					fromManifest: device.surface.fromManifest,
					bitmapFormat: device.bitmapFormat,
					supportsBrightness: device.supportsBrightness,
					supportsLockedState: device.supportsLockedState,
					canChangePage: device.canChangePage ?? null,
					variables: device.variables,
					configFields: device.configFields ?? null,
					configValues: runtime.configValuesFor(device.id),
					// Inert text. Displayed, never fetched, never linkified — docs/design.md §9.1.
					firmwareUpdateUrl: device.firmwareUpdateUrl,
					controls: [...device.surface.controls.values()].map((control) => ({
						id: control.id,
						row: control.row,
						column: control.column,
						style: control.style,
					})),
				}
			: null,
		scenario: running ? { id: running.scenario.id, name: running.scenario.name } : null,
		apiVersion: session.connection?.capabilities.apiVersion ?? null,
		connected: session.connection !== undefined,
		keepalives: {
			in: session.keepalivesIn,
			out: session.keepalivesOut,
			lastAt: session.lastKeepaliveAt ?? null,
		},
	}
}

/** What each control currently looks like, as data URLs the UI can render directly. */
function surfaceSnapshot(runtime: MockRuntime, deviceId: string) {
	const deviceRuntime = runtime.runtimeFor(deviceId)
	if (!deviceRuntime) return []

	return [...deviceRuntime.device.surface.controls.values()].map((control) => {
		// What was sent, not what the scenario last asked for: they differ when frames are throttled.
		const style = deviceRuntime.emitter.sentStyleOf(control.id)
		// Always a PNG for the UI regardless of what the device negotiated: the browser has a decoder
		// and raw rgb would mean shipping 15KB per tile and decoding it in JavaScript.
		const preview = runtime.renderer.render(style, {
			width: control.style.bitmap?.w ?? 72,
			height: control.style.bitmap?.h ?? 72,
			format: 'png',
		})
		return {
			id: control.id,
			row: control.row,
			column: control.column,
			preview,
			style: {
				bgColor: style.bgColor,
				textColor: style.textColor,
				text: style.text,
				fontSize: style.fontSize,
				pressed: style.pressed,
				type: style.type,
			},
			wants: {
				bitmap: control.style.bitmap ?? null,
				colors: control.style.colors ?? null,
				text: control.style.text ?? false,
				textStyle: control.style.textStyle ?? false,
				leds: control.style.leds ?? null,
			},
		}
	})
}

const poll = async function* <T>(read: () => T, signal: AbortSignal, intervalMs: number) {
	// Polling rather than an event stream: coalescing is the point. A surface being redrawn at 30fps
	// should not push 30 updates a second at a browser that can only show a handful, and the UI is
	// never the reason the server is busy.
	let last = ''
	while (!signal.aborted) {
		const value = read()
		const serialised = JSON.stringify(value)
		if (serialised !== last) {
			last = serialised
			yield value
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs))
	}
}

export const appRouter = t.router({
	server: publicProcedure.query(({ ctx }) => ({
		apiVersions: KNOWN_API_VERSIONS,
		sessionCount: ctx.runtime.sessions.size,
	})),

	scenarios: publicProcedure.query(() =>
		BUILTIN_SCENARIOS.map((scenario) => ({
			id: scenario.id,
			name: scenario.name,
			description: scenario.description,
			wants: scenario.wants ?? [],
		}))
	),

	/** Sessions this browser holds. There is deliberately no way to list anyone else's. */
	mySessions: publicProcedure.query(({ ctx }) =>
		ctx.runtime.sessions
			.all()
			.filter((session) => session.claimedBy === ctx.uiClientId)
			.map((session) => sessionSnapshot(ctx.runtime, session.id))
			.filter((snapshot) => snapshot !== null)
	),

	claim: mutation.input(z.object({ code: z.string().min(1).max(32) })).mutation(({ ctx, input }) => {
		const result = ctx.runtime.sessions.claim(input.code, ctx.uiClientId, ctx.clientIp)
		if (!result.ok) {
			throw new TRPCError({
				code: result.reason === 'rate-limited' || result.reason === 'busy' ? 'TOO_MANY_REQUESTS' : 'NOT_FOUND',
				message:
					result.reason === 'rate-limited'
						? 'Too many attempts. Wait a moment.'
						: result.reason === 'busy'
							? 'The server is refusing claims for a moment. Try again shortly.'
							: result.reason === 'too-many-sessions'
								? 'You already hold the maximum number of sessions'
								: 'No session with that code',
			})
		}

		// Switching off Unclaimed is the visible signal that the claim worked, on the surface itself.
		if (result.session.primaryDeviceId) {
			ctx.runtime.selectScenario(result.session.primaryDeviceId, 'input-echo')
		}
		return { sessionId: result.session.id }
	}),

	unclaim: mutation.input(sessionIdInput).mutation(({ ctx, input }) => {
		const session = requireClaimed(ctx, input.sessionId)
		session.unclaim()
		// Back to Unclaimed, with the new code drawn on the surface.
		if (session.primaryDeviceId) ctx.runtime.selectScenario(session.primaryDeviceId, 'unclaimed')
		return { ok: true }
	}),

	session: publicProcedure.input(sessionIdInput).query(({ ctx, input }) => {
		requireClaimed(ctx, input.sessionId)
		return sessionSnapshot(ctx.runtime, input.sessionId)
	}),

	watchSession: publicProcedure.input(sessionIdInput).subscription(async function* ({ ctx, input, signal }) {
		requireClaimed(ctx, input.sessionId)
		yield* poll(() => sessionSnapshot(ctx.runtime, input.sessionId), signal!, 250)
	}),

	watchSurface: publicProcedure.input(sessionIdInput).subscription(async function* ({ ctx, input, signal }) {
		const session = requireClaimed(ctx, input.sessionId)
		yield* poll(
			() => (session.primaryDeviceId ? surfaceSnapshot(ctx.runtime, session.primaryDeviceId) : []),
			signal!,
			// 10fps: fast enough to look live next to the real device, slow enough that the UI can
			// never be the reason the server is busy.
			100
		)
	}),

	watchTrace: publicProcedure.input(sessionIdInput).subscription(async function* ({ ctx, input, signal }) {
		const session = requireClaimed(ctx, input.sessionId)
		let sent = 0
		while (!signal!.aborted) {
			if (session.trace.length < sent) sent = 0 // the ring buffer wrapped
			if (session.trace.length > sent) {
				yield session.trace.slice(sent)
				sent = session.trace.length
			}
			await new Promise((resolve) => setTimeout(resolve, 150))
		}
	}),

	selectScenario: mutation
		.input(sessionIdInput.extend({ scenarioId: z.string().min(1).max(64) }))
		.mutation(({ ctx, input }) => {
			const session = requireClaimed(ctx, input.sessionId)
			if (!session.primaryDeviceId) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No device' })
			if (!ctx.runtime.selectScenario(session.primaryDeviceId, input.scenarioId)) {
				throw new TRPCError({ code: 'NOT_FOUND', message: 'No such scenario' })
			}
			return { ok: true }
		}),

	sendRaw: mutation.input(sessionIdInput.extend({ line: z.string().min(1).max(4096) })).mutation(({ ctx, input }) => {
		const session = requireClaimed(ctx, input.sessionId)
		if (!session.connection) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Client not connected' })

		// Upstream does no escaping on output, so a value containing a quote or newline produces a
		// line that parses back as something else. Refuse rather than emit a corrupt frame.
		if (!isSafeValue(input.line)) {
			throw new TRPCError({ code: 'BAD_REQUEST', message: 'Line may not contain quotes or newlines' })
		}

		session.connection.send(`${input.line}\n`)
		session.record('out', input.line)
		return { ok: true }
	}),

	chaos: publicProcedure.input(sessionIdInput).query(({ ctx, input }) => {
		const session = requireClaimed(ctx, input.sessionId)
		if (!session.connection) return DEFAULT_CHAOS
		return ctx.satellite.chaosFor(session.connection)?.config ?? DEFAULT_CHAOS
	}),

	setChaos: mutation.input(sessionIdInput.extend({ config: ChaosConfigSchema })).mutation(({ ctx, input }) => {
		const session = requireClaimed(ctx, input.sessionId)
		if (!session.connection) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Client not connected' })

		// Scoped to this session's connection only. A tool that could be pointed at someone
		// else's connection would be an amplifier rather than a test tool.
		if (!ctx.satellite.setChaos(session.connection, input.config)) {
			throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No live connection' })
		}
		return { ok: true }
	}),

	/** Active subscriptions on this session's connection, with what each location currently shows. */
	subscriptions: publicProcedure.input(sessionIdInput).query(({ ctx, input }) => {
		const session = requireClaimed(ctx, input.sessionId)
		if (!session.connection) return []

		return [...session.connection.subscriptions.values()].map((subscription) => {
			const location = `${subscription.location.pageNumber}/${subscription.location.row}/${subscription.location.column}`
			const style = ctx.runtime.pages.get(location)
			return {
				subId: subscription.subId,
				location,
				bitmapFormat: subscription.bitmapFormat,
				wants: {
					bitmap: subscription.style.bitmap ?? null,
					colors: subscription.style.colors ?? null,
					text: subscription.style.text ?? false,
					textStyle: subscription.style.textStyle ?? false,
				},
				content: { bgColor: style.bgColor, textColor: style.textColor, text: style.text },
			}
		})
	}),

	setPageContent: mutation
		.input(
			sessionIdInput.extend({
				location: z.string().regex(/^\d{1,4}\/\d{1,4}\/\d{1,4}$/, 'Expected page/row/column'),
				text: z.string().max(256).default(''),
				bgColor: z
					.string()
					.regex(/^#[0-9a-fA-F]{6}$/)
					.default('#000000'),
				textColor: z
					.string()
					.regex(/^#[0-9a-fA-F]{6}$/)
					.default('#ffffff'),
			})
		)
		.mutation(({ ctx, input }) => {
			requireClaimed(ctx, input.sessionId)
			// Broadcasts to every subscription watching this location, across connections — which is
			// what the protocol does. It carries no session's private data, only what was typed here.
			const notified = ctx.runtime.setPageContent(input.location, {
				text: input.text,
				bgColor: input.bgColor,
				textColor: input.textColor,
			})
			return { notified }
		}),

	setConfigValue: mutation
		.input(
			sessionIdInput.extend({
				fieldId: z.string().min(1).max(128),
				value: z.union([z.string().max(1024), z.number(), z.boolean()]),
			})
		)
		.mutation(({ ctx, input }) => {
			const session = requireClaimed(ctx, input.sessionId)
			if (!session.primaryDeviceId) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No device' })

			if (!ctx.runtime.setConfigValue(session.primaryDeviceId, input.fieldId, input.value)) {
				throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not a valid value for that field' })
			}
			return { ok: true }
		}),

	/**
	 * Drop the client, optionally with a status code, optionally refusing it back for a while.
	 *
	 * The blackout is deliberately keyed on the address of *this session's own connection* and
	 * nothing else. An operator can hold out the client they are already holding the claim code
	 * for, which is themselves; there is no input by which another address could be named.
	 */
	disconnect: mutation
		.input(
			sessionIdInput.extend({
				/** Restricted to codes a server may legitimately send; 1005/1006 are never on the wire. */
				code: z
					.union([z.literal(1000), z.literal(1001), z.literal(1008), z.literal(1011), z.literal(1013)])
					.optional(),
				reason: z.string().max(80).optional(),
				blackoutMs: z.number().int().min(0).max(MAX_BLACKOUT_MS).default(0),
			})
		)
		.mutation(({ ctx, input }) => {
			const session = requireClaimed(ctx, input.sessionId)
			if (!session.connection)
				throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Client not connected' })

			const ip = session.connection.connection.remoteAddress
			// Started before the close so there is no window in which a fast client reconnects first.
			const until = input.blackoutMs > 0 ? ctx.satellite.blackoutIp(ip, input.blackoutMs) : null

			session.connection.close(input.code, input.reason)
			return { ok: true, blackoutUntil: until }
		}),

	/** How much longer this session's address is being refused, if it is. */
	blackout: publicProcedure.input(sessionIdInput).query(({ ctx, input }) => {
		const session = requireClaimed(ctx, input.sessionId)
		const ip = session.connection?.connection.remoteAddress ?? session.lastRemoteAddress
		const state = ip ? ctx.satellite.blackoutFor(ip) : undefined
		return { active: state !== undefined, remainingMs: state?.remainingMs ?? 0, maxMs: MAX_BLACKOUT_MS }
	}),

	/** End a blackout early, for when a minute of waiting is no longer interesting. */
	clearBlackout: mutation.input(sessionIdInput).mutation(({ ctx, input }) => {
		const session = requireClaimed(ctx, input.sessionId)
		const ip = session.connection?.connection.remoteAddress ?? session.lastRemoteAddress
		if (!ip) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No address on record' })

		ctx.satellite.clearBlackout(ip)
		return { ok: true }
	}),
})

export type AppRouter = typeof appRouter
