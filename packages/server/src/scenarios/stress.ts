import { z } from 'zod'
import { hslToHex } from './builtin.js'
import type { Scenario } from './types.js'

/**
 * The bounded load tool.
 *
 * Framed as a payload sweep rather than a raw flood, deliberately. A flood mostly measures the
 * server and the network — and with the render cache warm the server barely notices, so the number
 * it produces is not about the device at all. What is actually useful is finding where a *client's*
 * decode and render pipeline falls over, which is a function of payload size and rate, not of how
 * many messages the server can emit.
 *
 * Every bound here is a hard cap rather than a default: the run auto-expires, the frame rate is
 * limited, and the whole thing still passes through the per-session render budget and the
 * connection's byte limits.
 */
export const StressParamsSchema = z.object({
	/** Frames per second across the whole surface. */
	fps: z.number().int().min(1).max(30).default(10),
	/** Seconds before the run stops itself. */
	durationSec: z.number().int().min(1).max(60).default(20),
	/** Controls to drive each frame; the surface size is the real ceiling. */
	controls: z.number().int().min(1).max(512).default(32),
})

export type StressParams = z.infer<typeof StressParamsSchema>

export const stressScenario: Scenario = {
	id: 'stress',
	name: 'Load sweep',
	description:
		'Drives the surface at a capped frame rate for a fixed time, to find where a client stops ' +
		'keeping up. Auto-stops. Measures the client, not the server — the render cache means the ' +
		'server barely notices.',
	wants: ['colors', 'bitmaps'],
	// The engine's own resolution is the floor; fps is honoured by drawing more per tick if needed.
	tickMs: 33,

	init(context) {
		const params = StressParamsSchema.parse(context.params)
		context.state.set('params', params)
		context.state.set('startedAt', Date.now())
		context.state.set('frames', 0)
		context.state.set('lastFrameAt', 0)
		context.drawAll({ bgColor: '#000000', text: '' })
	},

	tick(context) {
		const params = context.state.get('params') as StressParams
		const startedAt = context.state.get('startedAt') as number
		const elapsed = Date.now() - startedAt

		if (elapsed > params.durationSec * 1000) {
			// Stops itself rather than relying on anyone remembering to. A load tool that runs until
			// someone notices is a load tool that gets left on.
			const frames = context.state.get('frames') as number
			context.drawAll({ bgColor: '#101010', textColor: '#ffffff', text: '' })
			context.draw(context.controlIds[0] ?? '', {
				text: `DONE\n${frames}f`,
				bgColor: '#103010',
				textColor: '#80ff80',
			})
			context.state.set('startedAt', Number.POSITIVE_INFINITY)
			return
		}
		if (!Number.isFinite(startedAt)) return

		const minInterval = 1000 / params.fps
		const lastFrameAt = context.state.get('lastFrameAt') as number
		if (Date.now() - lastFrameAt < minInterval) return
		context.state.set('lastFrameAt', Date.now())

		const frame = ((context.state.get('frames') as number) ?? 0) + 1
		context.state.set('frames', frame)

		const count = Math.min(params.controls, context.controlIds.length)
		for (let i = 0; i < count; i++) {
			const controlId = context.controlIds[i]
			if (!controlId) continue
			// Unique content every frame, so nothing is served from the render cache — otherwise this
			// measures the cache rather than the pipeline.
			context.draw(controlId, {
				bgColor: hslToHex((frame * 7 + i * 13) % 360, 70, 45),
				textColor: '#ffffff',
				text: `${frame}`,
			})
		}
	},
}
