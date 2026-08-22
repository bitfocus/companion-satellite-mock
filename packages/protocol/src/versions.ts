import { BITMAP_FORMATS, type BitmapFormat } from './constants.js'

/**
 * What a given advertised API version can do.
 *
 * Every outbound field and every inbound command handler consults this, which is what makes the web
 * UI's version selector produce a genuinely older server rather than a cosmetically older banner.
 * See docs/protocol.md §6.
 */
export interface SatelliteCapabilities {
	readonly apiVersion: string

	/** `CAPS` is only sent from 1.10.0. Before that, clients infer everything from `ApiVersion`. */
	readonly sendsCaps: boolean

	readonly keyStateTypeAndPressed: boolean
	readonly errorsIncludeDeviceId: boolean
	readonly keyRotate: boolean
	readonly textStyle: boolean
	readonly bitmapSizeParam: boolean
	readonly unboundedGrid: boolean
	readonly rowColumnKeys: boolean
	readonly textColor: boolean
	readonly colorFormatChoice: boolean
	readonly transferableValues: boolean
	readonly brightnessOptOut: boolean
	readonly echoVariableOnOk: boolean
	readonly pincodeLock: boolean
	readonly layoutManifest: boolean
	readonly subscriptions: boolean
	readonly keyStateLocation: boolean
	readonly serialParam: boolean
	readonly configFields: boolean
	readonly changePage: boolean
	readonly firmwareUpdateInfo: boolean
	readonly lockedStateRotation: boolean
	readonly nonSquare: boolean
	readonly bitmapFormats: readonly BitmapFormat[]
	readonly leds: boolean
	readonly rotaryAmount: boolean
}

/** Known API versions, with the Companion releases that introduced them (from the published spec). */
export const KNOWN_API_VERSIONS = [
	{ version: '1.0.0', companion: null },
	{ version: '1.1.0', companion: null },
	{ version: '1.2.0', companion: null },
	{ version: '1.3.0', companion: null },
	{ version: '1.4.0', companion: 'v3.0+' },
	{ version: '1.5.0', companion: 'v3.2+' },
	{ version: '1.5.1', companion: null },
	{ version: '1.6.0', companion: null },
	{ version: '1.7.0', companion: 'v3.4+' },
	{ version: '1.7.1', companion: null },
	{ version: '1.8.0', companion: 'v4.0+' },
	{ version: '1.9.0', companion: 'v4.2+' },
	{ version: '1.10.0', companion: 'v4.3+' },
	{ version: '1.10.1', companion: null },
	{ version: '1.11.0', companion: 'v5.0+' },
	{ version: '1.12.0', companion: 'v5.0+' },
	{ version: '1.13.0', companion: 'v5.1+' },
	{ version: '1.14.0', companion: 'v5.1+' },
] as const satisfies readonly { version: string; companion: string | null }[]

/** Compare two `x.y.z` versions. Not general-purpose semver — no prerelease or build metadata. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split('.').map(Number)
	const pb = b.split('.').map(Number)
	for (let i = 0; i < 3; i++) {
		const va = pa[i] ?? 0
		const vb = pb[i] ?? 0
		if (Number.isNaN(va) || Number.isNaN(vb)) throw new Error(`Invalid version: ${Number.isNaN(va) ? a : b}`)
		if (va !== vb) return va < vb ? -1 : 1
	}
	return 0
}

const atLeast = (version: string, target: string): boolean => compareVersions(version, target) >= 0

/**
 * Derive the capability set for an advertised API version.
 *
 * `bitmapFormats` is the set the server *can* offer at this version; the operator may narrow it
 * further from the UI to test a client's fallback path.
 */
export function capabilitiesFor(apiVersion: string): SatelliteCapabilities {
	// Throws on a malformed version, so a typo in the UI surfaces immediately rather than silently
	// producing a 1.0.0-shaped server.
	compareVersions(apiVersion, '0.0.0')

	return {
		apiVersion,
		sendsCaps: atLeast(apiVersion, '1.10.0'),
		keyStateTypeAndPressed: atLeast(apiVersion, '1.1.0'),
		errorsIncludeDeviceId: atLeast(apiVersion, '1.2.0'),
		keyRotate: atLeast(apiVersion, '1.3.0'),
		textStyle: atLeast(apiVersion, '1.4.0'),
		bitmapSizeParam: atLeast(apiVersion, '1.5.0'),
		unboundedGrid: atLeast(apiVersion, '1.5.1'),
		rowColumnKeys: atLeast(apiVersion, '1.6.0'),
		textColor: atLeast(apiVersion, '1.6.0'),
		colorFormatChoice: atLeast(apiVersion, '1.6.0'),
		transferableValues: atLeast(apiVersion, '1.7.0'),
		brightnessOptOut: atLeast(apiVersion, '1.7.0'),
		echoVariableOnOk: atLeast(apiVersion, '1.7.1'),
		pincodeLock: atLeast(apiVersion, '1.8.0'),
		layoutManifest: atLeast(apiVersion, '1.9.0'),
		subscriptions: atLeast(apiVersion, '1.10.0'),
		keyStateLocation: atLeast(apiVersion, '1.10.0'),
		serialParam: atLeast(apiVersion, '1.10.0'),
		configFields: atLeast(apiVersion, '1.10.0'),
		changePage: atLeast(apiVersion, '1.10.0'),
		firmwareUpdateInfo: atLeast(apiVersion, '1.10.0'),
		lockedStateRotation: atLeast(apiVersion, '1.10.1'),
		nonSquare: atLeast(apiVersion, '1.11.0'),
		bitmapFormats: atLeast(apiVersion, '1.12.0') ? BITMAP_FORMATS : (['rgb'] as const),
		leds: atLeast(apiVersion, '1.13.0'),
		rotaryAmount: atLeast(apiVersion, '1.14.0'),
	}
}

/**
 * Validate a client-requested bitmap format against what this server actually offers.
 * Anything absent or unadvertised falls back to `rgb` — never assume a decoder a client didn't ask for.
 */
export function parseBitmapFormat(value: string | true | undefined, offered: readonly BitmapFormat[]): BitmapFormat {
	if (typeof value === 'string' && (offered as readonly string[]).includes(value)) {
		return value as BitmapFormat
	}
	return 'rgb'
}

/**
 * Resolve the rotation delta from a `DIRECTION` parameter.
 *
 * Since 1.14 this is a signed step count. `0` means a single counter-clockwise step, kept for
 * clients that treated it as a boolean. A non-numeric value falls back to "anything >= '1' is
 * clockwise". When the server is pretending to predate 1.14, magnitude is discarded.
 */
export function parseRotationDelta(direction: string | true | undefined, rotaryAmount: boolean): number {
	let delta: number
	if (typeof direction === 'string') {
		const num = Number(direction)
		delta = Number.isFinite(num) ? (num === 0 ? -1 : num) : direction >= '1' ? 1 : -1
	} else {
		delta = direction !== undefined ? 1 : -1
	}
	if (!rotaryAmount) return delta < 0 ? -1 : 1
	return delta
}
