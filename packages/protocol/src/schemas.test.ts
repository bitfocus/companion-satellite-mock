import { describe, expect, it } from 'vitest'
import { SatelliteSurfaceLayoutSchema } from '@companion-app/satellite-protocol/schemas'
import { SatelliteConfigFieldsSchema } from '@companion-app/satellite-protocol/schemas'

/**
 * These schemas are copied verbatim from Companion, so these tests are not testing zod — they are a
 * tripwire. If a refresh from upstream changes what a client may send, one of these fails and the
 * change gets noticed rather than silently altering what the mock accepts.
 */

describe('SatelliteSurfaceLayoutSchema', () => {
	it('accepts the example manifest from the published spec', () => {
		const parsed = SatelliteSurfaceLayoutSchema.safeParse({
			stylePresets: {
				default: { bitmap: { w: 72, h: 72 }, colors: 'hex' },
				encoder: { colors: 'hex', leds: { segments: 24, mode: 'full-ring' } },
			},
			controls: {
				'0/0': { row: 0, column: 0 },
				'0/1': { row: 0, column: 1 },
				'enc/0': { row: 0, column: 2, stylePreset: 'encoder' },
			},
		})
		expect(parsed.success).toBe(true)
	})

	it('requires a default style preset', () => {
		const parsed = SatelliteSurfaceLayoutSchema.safeParse({
			stylePresets: { other: {} },
			controls: {},
		})
		expect(parsed.success).toBe(false)
	})

	it('rejects a control id outside the documented charset', () => {
		const bad = (id: string) =>
			SatelliteSurfaceLayoutSchema.safeParse({
				stylePresets: { default: {} },
				controls: { [id]: { row: 0, column: 0 } },
			}).success

		expect(bad('enc/0')).toBe(true)
		expect(bad('a-b')).toBe(true)
		expect(bad('has space')).toBe(false)
		expect(bad('emoji✨')).toBe(false)
	})

	it('rejects negative positions and out-of-range led segments', () => {
		expect(
			SatelliteSurfaceLayoutSchema.safeParse({
				stylePresets: { default: {} },
				controls: { a: { row: -1, column: 0 } },
			}).success
		).toBe(false)

		const leds = (segments: number) =>
			SatelliteSurfaceLayoutSchema.safeParse({
				stylePresets: { default: { leds: { segments, mode: 'simple' } } },
				controls: {},
			}).success

		expect(leds(1)).toBe(true)
		expect(leds(200)).toBe(true)
		expect(leds(0)).toBe(false)
		expect(leds(201)).toBe(false)
	})

	it('rejects an unknown colors format and an unknown led mode', () => {
		expect(
			SatelliteSurfaceLayoutSchema.safeParse({
				stylePresets: { default: { colors: 'bgr' } },
				controls: {},
			}).success
		).toBe(false)

		expect(
			SatelliteSurfaceLayoutSchema.safeParse({
				stylePresets: { default: { leds: { segments: 8, mode: 'half-ring' } } },
				controls: {},
			}).success
		).toBe(false)
	})
})

describe('SatelliteConfigFieldsSchema', () => {
	it('accepts one field of every documented type', () => {
		const parsed = SatelliteConfigFieldsSchema.safeParse([
			{ id: 'a', label: 'Static', type: 'static-text', value: 'hello' },
			{ id: 'b', label: 'Text', type: 'textinput', default: 'x', regex: '^\\d+$', multiline: false },
			{ id: 'c', label: 'Drop', type: 'dropdown', choices: [{ id: 1, label: 'One' }], default: 1 },
			{ id: 'd', label: 'Num', type: 'number', min: 0, max: 10, step: 1 },
			{ id: 'e', label: 'Check', type: 'checkbox', default: true },
		])
		expect(parsed.success).toBe(true)
	})

	it('accepts an empty array', () => {
		expect(SatelliteConfigFieldsSchema.safeParse([]).success).toBe(true)
	})

	it('rejects an unknown field type', () => {
		expect(SatelliteConfigFieldsSchema.safeParse([{ id: 'a', label: 'x', type: 'colorpicker' }]).success).toBe(
			false
		)
	})

	it('requires min and max on a number field', () => {
		expect(SatelliteConfigFieldsSchema.safeParse([{ id: 'a', label: 'x', type: 'number' }]).success).toBe(false)
	})

	it('requires at least one dropdown choice', () => {
		expect(
			SatelliteConfigFieldsSchema.safeParse([{ id: 'a', label: 'x', type: 'dropdown', choices: [] }]).success
		).toBe(false)
	})
})
