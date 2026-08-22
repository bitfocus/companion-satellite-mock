/**
 * Map a gauge value onto an addressable LED strip or ring.
 *
 * Companion samples a gauge element down to one colour per segment and streams the result in `LEDS`.
 * This is an approximation of that — the mock has no gauge model, and does not need one: its job is
 * to give a client plausible, checkable LED data, not to be pixel-identical to Companion.
 *
 * The two modes come from the published schema:
 * - `full-ring`: the LEDs form a circle. Segment 0 sits at 6 o'clock and indices increase clockwise.
 * - `simple`: any other shape. The value sweeps across all segments, segment 0 being the 0% end.
 *
 * Both describe the *logical* ordering Companion streams; a surface re-maps to its own wiring.
 */
export type LedMode = 'full-ring' | 'simple'

export interface LedColor {
	r: number
	g: number
	b: number
}

const OFF: LedColor = { r: 0, g: 0, b: 0 }

/** A green-to-red sweep, so the value is readable at a glance on a test surface. */
function colorForPosition(position: number): LedColor {
	const clamped = Math.min(1, Math.max(0, position))
	return {
		r: Math.round(255 * clamped),
		g: Math.round(255 * (1 - clamped)),
		b: 0,
	}
}

/**
 * Sample a 0-1 gauge value into per-segment colours.
 *
 * Segments beyond the value are off rather than dimmed, which matches the documented behaviour that
 * an absent `LEDS` field means "all off" — a client that treats off-segments as unchanged shows
 * stale colour, and this makes that visible.
 */
export function sampleLeds(value: number, segments: number, mode: LedMode): LedColor[] {
	if (segments < 1) return []
	const clamped = Math.min(1, Math.max(0, value))

	const out: LedColor[] = []
	for (let i = 0; i < segments; i++) {
		// Both modes light segments up to the value; `full-ring` differs only in that a real ring
		// gauge would honour angles and a deadzone, which the mock has no source for.
		const position = segments === 1 ? 1 : i / (segments - 1)
		out.push(position <= clamped ? colorForPosition(position) : OFF)
	}

	if (mode === 'full-ring') {
		// Segment 0 is at 6 o'clock: rotate so the sweep starts at the bottom rather than the first
		// physical index, which is what makes a ring look right rather than lopsided.
		const offset = Math.floor(segments / 2)
		return [...out.slice(segments - offset), ...out.slice(0, segments - offset)]
	}

	return out
}

/** Pack sampled colours into the wire format: raw RGB, three bytes per segment. */
export function ledsToBuffer(colors: LedColor[]): Buffer {
	const out = Buffer.allocUnsafe(colors.length * 3)
	colors.forEach((color, index) => {
		out[index * 3] = color.r
		out[index * 3 + 1] = color.g
		out[index * 3 + 2] = color.b
	})
	return out
}

/** Convenience: sample and pack in one step, ready for the `LEDS` parameter. */
export function sampleLedsToBuffer(value: number, segments: number, mode: LedMode): Buffer {
	return ledsToBuffer(sampleLeds(value, segments, mode))
}
