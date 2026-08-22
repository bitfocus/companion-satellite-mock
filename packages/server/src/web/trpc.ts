import { initTRPC, TRPCError } from '@trpc/server'
import { z } from 'zod'
import { KNOWN_API_VERSIONS } from '@satellite-mock/protocol'
import { BUILTIN_SCENARIOS } from '../scenarios/builtin.js'
import type { MockRuntime } from '../runtime.js'
import { isSafeValue } from '@satellite-mock/protocol'
import { TokenBucket } from '../limits.js'

export interface TrpcContext {
	runtime: MockRuntime
	/** Opaque per-browser id, from localStorage. Not a credential — it scopes, it does not authorise. */
	uiClientId: string
}

const t = initTRPC.context<TrpcContext>().create()

/**
 * Mutations are rate limited per browser.
 *
 * The UI is public and unauthenticated, so every mutation is reachable by anyone. The claim flow has
 * its own stricter limiter in SessionManager; this is the blanket one that stops a script driving
 * scenario switches or raw sends in a tight loop.
 */
const mutationBuckets = new Map<string, TokenBucket>()

const rateLimited = t.middleware(({ ctx, next }) => {
	let bucket = mutationBuckets.get(ctx.uiClientId)
	if (!bucket) {
		bucket = new TokenBucket(60, 10)
		mutationBuckets.set(ctx.uiClientId, bucket)
	}
	if (!bucket.take()) {
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
		const style = deviceRuntime.emitter.styleOf(control.id)
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
		const result = ctx.runtime.sessions.claim(input.code, ctx.uiClientId)
		if (!result.ok) {
			throw new TRPCError({
				code: result.reason === 'rate-limited' ? 'TOO_MANY_REQUESTS' : 'NOT_FOUND',
				message:
					result.reason === 'rate-limited'
						? 'Too many attempts. Wait a moment.'
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

	disconnect: mutation.input(sessionIdInput).mutation(({ ctx, input }) => {
		const session = requireClaimed(ctx, input.sessionId)
		if (!session.connection) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Client not connected' })
		session.connection.close()
		return { ok: true }
	}),
})

export type AppRouter = typeof appRouter
