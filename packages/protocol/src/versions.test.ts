import { getSatelliteFeatures } from '@companion-app/satellite-protocol/versions'
import { describe, expect, it } from 'vitest'
import type { ParsedParams } from './parse.js'
import {
	KNOWN_API_VERSIONS,
	capabilitiesFor,
	compareVersions,
	parseBitmapFormat,
	parseRotationDelta,
} from './versions.js'
import { SUPPORTED_API_VERSION } from './constants.js'

describe('compareVersions', () => {
	it('orders correctly', () => {
		expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
		expect(compareVersions('1.10.1', '1.10.0')).toBe(1)
		expect(compareVersions('1.5.1', '1.5.1')).toBe(0)
		expect(compareVersions('1.6', '1.6.0')).toBe(0)
	})

	it('rejects a malformed version', () => {
		expect(() => compareVersions('banana', '1.0.0')).toThrow(/Invalid version/)
	})
})

describe('KNOWN_API_VERSIONS', () => {
	it('is sorted ascending and ends at the version we support', () => {
		for (let i = 1; i < KNOWN_API_VERSIONS.length; i++) {
			const prev = KNOWN_API_VERSIONS[i - 1]!.version
			const cur = KNOWN_API_VERSIONS[i]!.version
			expect(compareVersions(prev, cur), `${prev} should precede ${cur}`).toBe(-1)
		}
		expect(KNOWN_API_VERSIONS.at(-1)!.version).toBe(SUPPORTED_API_VERSION)
	})
})

describe('capabilitiesFor', () => {
	it('gates the whole feature set at 1.0.0', () => {
		const caps = capabilitiesFor('1.0.0')
		expect(caps.sendsCaps).toBe(false)
		expect(caps.keyRotate).toBe(false)
		expect(caps.subscriptions).toBe(false)
		expect(caps.leds).toBe(false)
		expect(caps.bitmapFormats).toEqual(['rgb'])
	})

	it('describes a 1.6.0 server: no CAPS, no LOCATION, no subscriptions, rgb only', () => {
		const caps = capabilitiesFor('1.6.0')
		expect(caps.sendsCaps).toBe(false)
		expect(caps.keyStateLocation).toBe(false)
		expect(caps.subscriptions).toBe(false)
		expect(caps.textColor).toBe(true)
		expect(caps.rowColumnKeys).toBe(true)
		expect(caps.pincodeLock).toBe(false)
		expect(caps.bitmapFormats).toEqual(['rgb'])
		expect(caps.rotaryAmount).toBe(false)
	})

	it('turns CAPS and the 1.10 feature set on together', () => {
		const before = capabilitiesFor('1.9.0')
		const after = capabilitiesFor('1.10.0')
		expect(before.sendsCaps).toBe(false)
		expect(after.sendsCaps).toBe(true)
		for (const key of [
			'subscriptions',
			'keyStateLocation',
			'serialParam',
			'configFields',
			'changePage',
			'firmwareUpdateInfo',
		] as const) {
			expect(before[key], `${key} before 1.10`).toBe(false)
			expect(after[key], `${key} at 1.10`).toBe(true)
		}
	})

	it('enables everything at the supported version', () => {
		const caps = capabilitiesFor(SUPPORTED_API_VERSION)
		expect(caps.leds).toBe(true)
		expect(caps.rotaryAmount).toBe(true)
		expect(caps.nonSquare).toBe(true)
		expect(caps.bitmapFormats).toEqual(['rgb', 'png', 'webp'])
	})

	it('is monotonic: no capability is ever lost by moving forward', () => {
		const booleanKeys = (
			Object.keys(capabilitiesFor('1.14.0')) as (keyof ReturnType<typeof capabilitiesFor>)[]
		).filter((k) => typeof capabilitiesFor('1.14.0')[k] === 'boolean')

		for (let i = 1; i < KNOWN_API_VERSIONS.length; i++) {
			const prev = capabilitiesFor(KNOWN_API_VERSIONS[i - 1]!.version)
			const cur = capabilitiesFor(KNOWN_API_VERSIONS[i]!.version)
			for (const key of booleanKeys) {
				if (prev[key] === true) {
					expect(cur[key], `${key} regressed at ${KNOWN_API_VERSIONS[i]!.version}`).toBe(true)
				}
			}
		}
	})

	it('rejects a malformed version rather than silently behaving like 1.0.0', () => {
		expect(() => capabilitiesFor('not-a-version')).toThrow()
	})
})

describe('parseBitmapFormat', () => {
	const all = ['rgb', 'png', 'webp'] as const

	it('accepts an offered format', () => {
		expect(parseBitmapFormat('webp', all)).toBe('webp')
	})

	it('falls back to rgb when absent, unknown, or not offered', () => {
		expect(parseBitmapFormat(undefined, all)).toBe('rgb')
		expect(parseBitmapFormat('jpeg', all)).toBe('rgb')
		expect(parseBitmapFormat(true, all)).toBe('rgb')
		expect(parseBitmapFormat('webp', ['rgb'])).toBe('rgb')
	})
})

describe('parseRotationDelta', () => {
	it('quirk 14: treats 0 as a single counter-clockwise step', () => {
		expect(parseRotationDelta('0', true)).toBe(-1)
	})

	it('carries the magnitude when the server advertises ROTARY_AMOUNT', () => {
		expect(parseRotationDelta('5', true)).toBe(5)
		expect(parseRotationDelta('-3', true)).toBe(-3)
	})

	it('clamps to a single step when pretending to predate 1.14', () => {
		expect(parseRotationDelta('5', false)).toBe(1)
		expect(parseRotationDelta('-3', false)).toBe(-1)
		expect(parseRotationDelta('0', false)).toBe(-1)
	})

	it('falls back to the legacy string comparison for a non-numeric value', () => {
		expect(parseRotationDelta('right', true)).toBe(1)
		expect(parseRotationDelta('!', true)).toBe(-1)
	})
})

describe("agreement with Companion's feature table", () => {
	// Every CAPS flag on, so the comparison is purely about which version a feature arrives in.
	const allEnabled = Object.assign(Object.create(null), {
		SUBSCRIPTIONS: '1',
		NONSQUARE: '1',
		BITMAP_FORMATS: 'rgb,png,webp',
		ROTARY_AMOUNT: '1',
	}) as ParsedParams

	it.each(KNOWN_API_VERSIONS.map((entry) => entry.version))(
		'gates each feature on the same version as Companion at %s',
		(version) => {
			const ours = capabilitiesFor(version)
			const upstream = getSatelliteFeatures(version, ours.sendsCaps ? allEnabled : null)
			expect({
				lockState: ours.pincodeLock,
				surfaceManifest: ours.layoutManifest,
				deviceSerial: ours.serialParam,
				caps: ours.sendsCaps,
				subscriptions: ours.subscriptions,
				keyStateLocation: ours.keyStateLocation,
				configFields: ours.configFields,
				changePage: ours.changePage,
				firmwareUpdateInfo: ours.firmwareUpdateInfo,
				nonSquareBitmaps: ours.nonSquare,
				bitmapFormats: ours.bitmapFormats.length > 1,
				leds: ours.leds,
				rotaryAmount: ours.rotaryAmount,
			}).toEqual(upstream)
		}
	)
})
