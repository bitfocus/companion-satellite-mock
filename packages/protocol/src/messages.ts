import type { BitmapFormat } from './constants.js'
import { serialiseMessage, type MessageArgs, type SerialiseOptions } from './serialise.js'
import type { SatelliteCapabilities } from './versions.js'
import type { SatelliteControlStylePreset } from '@companion-app/satellite-protocol/schemas'

/**
 * Builders for every message the server sends.
 *
 * Each one is gated by the active capability profile, so pretending to be an older server produces
 * genuinely older output rather than a cosmetically older banner. Nothing here renders or encodes —
 * callers pass values that are already computed, which keeps this package free of the graphics stack.
 */

export type ControlType = 'BUTTON' | 'PAGEUP' | 'PAGEDOWN' | 'PAGENUM'

/** Everything a control might report, before the style preset and capabilities filter it down. */
export interface ControlStyleValues {
	pressed: boolean
	type: ControlType
	/** Base64 for `rgb`, or a full `data:` url for `png`/`webp`. Already encoded by the renderer. */
	bitmap?: string
	/** `#rrggbb` or `rgb(r,g,b)`, already formatted per the preset's `colors` setting. */
	color?: string
	textColor?: string
	/** Raw text — base64 encoding happens here, so callers can't forget it. */
	text?: string
	fontSize?: number | 'auto'
	/** Base64 of packed RGB, one triple per segment. Always raw RGB, regardless of bitmap format. */
	leds?: string
}

export const encodeBase64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

/**
 * How many bytes a base64 string will decode to, without decoding it.
 *
 * Four characters encode three bytes, minus the padding — and the padding matters: ignoring it
 * over-estimates by up to two bytes, which rejects payloads that are exactly at the limit.
 */
export function decodedBase64Length(value: string): number {
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
	return Math.floor((value.length / 4) * 3) - padding
}

/**
 * Decode a base64 parameter, refusing anything oversized *before* allocating.
 *
 * Returns `undefined` rather than throwing, because every caller is handling untrusted input from a
 * socket and wants to answer with a protocol error, not an exception.
 */
export function decodeBase64(value: string, maxDecodedBytes: number): string | undefined {
	if (decodedBase64Length(value) > maxDecodedBytes) return undefined
	try {
		return Buffer.from(value, 'base64').toString('utf8')
	} catch {
		return undefined
	}
}

/**
 * Assemble the style arguments shared by `KEY-STATE` and `SUB-STATE`.
 *
 * Two independent gates, and both matter: the control's style preset says what the *client asked
 * for*, and the capability profile says what this server *version* is able to send.
 */
export function buildStyleArgs(
	values: ControlStyleValues,
	preset: SatelliteControlStylePreset,
	caps: SatelliteCapabilities
): MessageArgs {
	const args: MessageArgs = {}

	if (caps.keyStateTypeAndPressed) {
		args['PRESSED'] = values.pressed
		args['TYPE'] = values.type
	}

	if (preset.bitmap && values.bitmap !== undefined) {
		args['BITMAP'] = values.bitmap
	}

	if (preset.colors && values.color !== undefined) {
		args['COLOR'] = values.color
		// TEXTCOLOR arrived in 1.6 alongside the colour-format choice; an older server sends only COLOR.
		if (caps.textColor && values.textColor !== undefined) {
			args['TEXTCOLOR'] = values.textColor
		}
	}

	if (preset.text && values.text !== undefined) {
		args['TEXT'] = encodeBase64(values.text)
	}

	if (preset.textStyle && caps.textStyle && values.fontSize !== undefined) {
		args['FONT_SIZE'] = values.fontSize
	}

	if (preset.leds && caps.leds && values.leds !== undefined) {
		args['LEDS'] = values.leds
	}

	return args
}

export interface HandshakeOptions extends SerialiseOptions {
	companionVersion: string
	/** Narrowed by the operator to test a client's fallback path; defaults to the version's own set. */
	bitmapFormats?: readonly BitmapFormat[]
	/** Companion exposes this as a user-config toggle, so it can be off on a version that supports it. */
	subscriptionsEnabled?: boolean
}

/** `BEGIN CompanionVersion="…" ApiVersion="…"` — always the first line on a new connection. */
export function buildBegin(caps: SatelliteCapabilities, options: HandshakeOptions): string {
	return serialiseMessage(
		'BEGIN',
		null,
		null,
		{ CompanionVersion: options.companionVersion, ApiVersion: caps.apiVersion },
		options
	)
}

/**
 * `CAPS …`, or `null` for a server too old to send it.
 *
 * Returning null rather than an empty string keeps the caller honest: a pre-1.10 server sends no
 * `CAPS` line at all, and clients are documented to infer feature *existence* from `ApiVersion`.
 */
export function buildCaps(caps: SatelliteCapabilities, options: HandshakeOptions): string | null {
	if (!caps.sendsCaps) return null

	const args: MessageArgs = {
		SUBSCRIPTIONS: caps.subscriptions && options.subscriptionsEnabled !== false,
	}
	if (caps.nonSquare) args['NONSQUARE'] = true
	const formats = options.bitmapFormats ?? caps.bitmapFormats
	if (caps.bitmapFormats.length > 1) args['BITMAP_FORMATS'] = formats.join(',')
	if (caps.rotaryAmount) args['ROTARY_AMOUNT'] = true

	return serialiseMessage('CAPS', null, null, args, options)
}

export interface KeyStateOptions extends SerialiseOptions {
	deviceId: string
	/** Legacy mode: the flat key index. Advanced mode: the manifest control id. Exactly one. */
	key?: number
	controlId?: string
	/** `page/row/column`, when known. Only sent from 1.10. */
	location?: string
	values: ControlStyleValues
	preset: SatelliteControlStylePreset
	caps: SatelliteCapabilities
}

export function buildKeyState(options: KeyStateOptions): string {
	const args: MessageArgs = {}

	if (options.controlId !== undefined) {
		args['CONTROLID'] = options.controlId
	} else if (options.key !== undefined) {
		args['KEY'] = options.key
	} else {
		throw new Error('buildKeyState requires either key or controlId')
	}

	if (options.location !== undefined && options.caps.keyStateLocation) {
		args['LOCATION'] = options.location
	}

	Object.assign(args, buildStyleArgs(options.values, options.preset, options.caps))

	return serialiseMessage('KEY-STATE', null, options.deviceId, args, options)
}

export interface SubStateOptions extends SerialiseOptions {
	subId: string
	values: ControlStyleValues
	preset: SatelliteControlStylePreset
	caps: SatelliteCapabilities
}

export function buildSubState(options: SubStateOptions): string {
	return serialiseMessage(
		'SUB-STATE',
		null,
		null,
		{ SUBID: options.subId, ...buildStyleArgs(options.values, options.preset, options.caps) },
		options
	)
}

export const buildKeysClear = (deviceId: string, options?: SerialiseOptions): string =>
	serialiseMessage('KEYS-CLEAR', null, deviceId, {}, options)

export const buildBrightness = (deviceId: string, value: number, options?: SerialiseOptions): string =>
	serialiseMessage('BRIGHTNESS', null, deviceId, { VALUE: value }, options)

export const buildVariableValue = (
	deviceId: string,
	variable: string,
	value: string,
	options?: SerialiseOptions
): string =>
	serialiseMessage('VARIABLE-VALUE', null, deviceId, { VARIABLE: variable, VALUE: encodeBase64(value) }, options)

export const buildDeviceConfig = (
	deviceId: string,
	config: Record<string, unknown>,
	options?: SerialiseOptions
): string =>
	serialiseMessage('DEVICE-CONFIG', null, deviceId, { CONFIG: encodeBase64(JSON.stringify(config)) }, options)

export interface LockedStateOptions extends SerialiseOptions {
	deviceId: string
	locked: boolean
	characterCount: number
	/** Only sent from 1.10.1. */
	rotation?: 0 | 90 | -90 | 180
	caps: SatelliteCapabilities
}

export function buildLockedState(options: LockedStateOptions): string {
	const args: MessageArgs = {
		LOCKED: options.locked,
		CHARACTER_COUNT: options.characterCount,
	}
	if (options.caps.lockedStateRotation) {
		args['ROTATION'] = options.rotation ?? 0
	}
	return serialiseMessage('LOCKED-STATE', null, options.deviceId, args, options)
}

/** `PONG <payload>` — the payload is echoed raw, exactly as received. */
export const buildPong = (payload: string, options?: SerialiseOptions): string =>
	serialiseMessage(`PONG ${payload}`, null, null, {}, options)

export const buildPing = (payload: string, options?: SerialiseOptions): string =>
	serialiseMessage(`PING ${payload}`, null, null, {}, options)

/**
 * A success response. `deviceId` is included when known — as is the error case, from 1.2 onwards.
 */
export function buildOk(
	messageName: string,
	deviceId: string | null,
	caps: SatelliteCapabilities,
	args: MessageArgs = {},
	options?: SerialiseOptions
): string {
	return serialiseMessage(messageName, 'OK', caps.errorsIncludeDeviceId ? deviceId : null, args, options)
}

export function buildErrorResponse(
	messageName: string,
	deviceId: string | null,
	message: string,
	caps: SatelliteCapabilities,
	options?: SerialiseOptions
): string {
	return serialiseMessage(
		messageName,
		'ERROR',
		caps.errorsIncludeDeviceId ? deviceId : null,
		{ MESSAGE: message },
		options
	)
}
