import type { SurfaceEmitter } from '../emitter.js'
import type { Surface } from '@satellite-mock/protocol'

/**
 * The screen shown to a client whose device id is already registered by someone else.
 *
 * This exists because the alternative is a dead end the client cannot see out of. Companion answers
 * such a registration with silence, and this server would too — except that pairing here needs a
 * claim code drawn on the surface, so a client that is refused a surface can never reach the web UI
 * to be told why. The one channel that reaches the developer is the surface in front of them.
 *
 * It is deliberately self-documenting about the divergence: the screen names the real behaviour and
 * how to get it, so the friendlier default teaches Companion's rule rather than hiding it. See
 * docs/design.md §4.4.
 */

/** Drawn in priority order; a surface with few keys still shows the first, most important ones. */
export function drawUnpairable(emitter: SurfaceEmitter, surface: Surface, deviceId: string): void {
	const controlIds = [...surface.controls.keys()]

	emitter.drawAll({ bgColor: '#101014', textColor: '#ffffff', text: '' })

	// Slots are allocated in priority order and never overlap. Written this way because the
	// equivalent screen for claim codes once painted an optional button over a required character
	// and produced an unusable code — see scenarios/unclaimed.test.ts.
	let next = 0
	const take = (): string | undefined => (next < controlIds.length ? controlIds[next++] : undefined)

	const paint = (id: string | undefined, style: Parameters<SurfaceEmitter['draw']>[1]): void => {
		if (id) emitter.draw(id, style)
	}

	paint(take(), { bgColor: '#8b0000', textColor: '#ffffff', text: "CAN'T\nPAIR" })
	paint(take(), { bgColor: '#5f1010', textColor: '#ffffff', text: 'ID IN\nUSE' })

	// Which id, so a developer running two builds knows which one collided.
	paint(take(), { bgColor: '#2a1a1a', textColor: '#cccccc', text: deviceId, fontSize: 8 })

	// Only if there is genuinely room. A small surface gets the three above and nothing else.
	paint(take(), { bgColor: '#1a1a2a', textColor: '#aaaaaa', text: 'REAL\nCOMPANION\nSAYS\nNOTHING', fontSize: 7 })
	paint(take(), { bgColor: '#1a1a2a', textColor: '#aaaaaa', text: '?duplicates\n=strict\nTO MATCH', fontSize: 7 })
}
