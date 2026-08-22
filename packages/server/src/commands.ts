import {
	buildErrorResponse,
	buildOk,
	buildSubState,
	buildSurface,
	controlAt,
	decodeBase64,
	ERRORS,
	ID_PATTERN,
	isFalsey,
	isTruthy,
	layoutFromLegacyParams,
	LOCATION_PATTERN,
	parseBitmapFormat,
	parseKeyParam,
	parseRotationDelta,
	parseTransferableValues,
	RESERVED_ID_PREFIXES,
	SatelliteConfigFieldsSchema,
	SatelliteSurfaceLayoutSchema,
	type ParsedParams,
	type TransferableValue,
	type SatelliteControlStylePreset,
} from '@satellite-mock/protocol'
import type { Device } from './devices.js'
import type { CommandContext, CommandHandler, SatelliteSession } from './satelliteSession.js'

/**
 * Handlers for every inbound command.
 *
 * Validation order matters and is copied from upstream: a client that sends a message with several
 * problems must be told about the *same* one Companion would report, or a client author debugging
 * against the mock chases a different bug than the one they have.
 */

/** How much decoded JSON we will accept in a single parameter, before parsing it. */
const MAX_DECODED_JSON_BYTES = 256 * 1024
const MAX_VARIABLES = 32
const MAX_CONFIG_FIELDS = 32
const MAX_DEVICES_PER_CONNECTION = 4
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 64
/** The mock actually rasterises every control, so it caps rendered controls below upstream's grid limit. */
const MAX_RENDERED_CONTROLS = 512
const MAX_BITMAP_DIMENSION = 512

function fail(session: SatelliteSession, messageName: string, deviceId: string | null, message: string): void {
	session.send(buildErrorResponse(messageName, deviceId, message, session.capabilities))
}

function ok(
	session: SatelliteSession,
	messageName: string,
	deviceId: string | null,
	args: Record<string, string | number | boolean> = {}
): void {
	session.send(buildOk(messageName, deviceId, session.capabilities, args))
}

/** Decode a base64 JSON parameter, size-checked before decode and before parse. */
function decodeJsonParam(value: string): unknown | undefined {
	const decoded = decodeBase64(value, MAX_DECODED_JSON_BYTES)
	if (decoded === undefined) return undefined
	try {
		return JSON.parse(decoded)
	} catch {
		return undefined
	}
}

/** Upstream's device lookup: missing id, or a device owned by someone else, are indistinguishable. */
function requireDevice(context: CommandContext, messageName: string): Device | undefined {
	const { session, params } = context
	if (!params.DEVICEID) {
		fail(session, messageName, null, ERRORS.missingDeviceId)
		return undefined
	}
	const id = String(params.DEVICEID)
	const device = session.devices.getOwned(id, session.connection)
	if (!device) {
		fail(session, messageName, id, ERRORS.deviceNotFound)
		return undefined
	}
	return device
}

function styleWithinLimits(style: SatelliteControlStylePreset): boolean {
	if (!style.bitmap) return true
	return style.bitmap.w <= MAX_BITMAP_DIMENSION && style.bitmap.h <= MAX_BITMAP_DIMENSION
}

const addDevice: CommandHandler = (context) => {
	const messageName = 'ADD-DEVICE'
	const { session, params } = context

	if (!params.DEVICEID || params.DEVICEID === true) return fail(session, messageName, null, ERRORS.missingDeviceId)
	if (!params.PRODUCT_NAME) return fail(session, messageName, String(params.DEVICEID), ERRORS.missingProductName)

	const id = String(params.DEVICEID)
	const serial = params.SERIAL ? String(params.SERIAL) : id

	// Upstream checks only `serial` here, so a reserved DEVICEID paired with a clean SERIAL is
	// accepted. Faithfully reproduced: a client relying on that would otherwise break against us.
	if (RESERVED_ID_PREFIXES.some((prefix) => serial.startsWith(prefix))) {
		return fail(session, messageName, id, params.SERIAL ? ERRORS.reservedSerial : ERRORS.reservedDeviceId)
	}

	const existing = session.devices.get(id)
	if (existing) {
		if (existing.connection === session.connection) return fail(session, messageName, id, ERRORS.deviceAlreadyAdded)
		// Quirk: the error goes to the socket that already holds the device, and the requesting
		// socket gets no reply at all.
		// Sent straight to the other connection rather than through its session: we hold the device,
		// not its session. It therefore does not appear in that session's trace, which is a known gap.
		existing.connection.send(
			buildErrorResponse(messageName, id, ERRORS.deviceExistsElsewhere, session.capabilities)
		)
		return
	}

	if (session.devices.forConnection(session.connection).length >= MAX_DEVICES_PER_CONNECTION) {
		return fail(session, messageName, id, 'Too many devices on this connection')
	}

	// --- layout ---
	let surface
	if (params.LAYOUT_MANIFEST && session.capabilities.layoutManifest) {
		const decoded = decodeJsonParam(String(params.LAYOUT_MANIFEST))
		const parsed = decoded === undefined ? undefined : SatelliteSurfaceLayoutSchema.safeParse(decoded)
		if (!parsed?.success) return fail(session, messageName, id, ERRORS.invalidLayoutManifest)
		surface = buildSurface(parsed.data, true)
	} else {
		const layout = layoutFromLegacyParams(params)
		if (typeof layout === 'string') return fail(session, messageName, id, layout)
		surface = buildSurface(layout, false)
	}

	if (surface.controls.size > MAX_RENDERED_CONTROLS) {
		return fail(session, messageName, id, `Too many controls (limit ${MAX_RENDERED_CONTROLS})`)
	}
	for (const control of surface.controls.values()) {
		// Rejected rather than silently clamped, so a client bug surfaces instead of producing
		// mysteriously wrong-sized images.
		if (!styleWithinLimits(control.style)) {
			return fail(session, messageName, id, `Bitmap too large (limit ${MAX_BITMAP_DIMENSION}px)`)
		}
	}

	// --- variables ---
	let variables: TransferableValue[] = []
	if (params.VARIABLES !== undefined && session.capabilities.transferableValues) {
		const decoded = decodeJsonParam(String(params.VARIABLES))
		const parsed = decoded === undefined ? undefined : parseTransferableValues(decoded)
		if (!parsed || parsed.length > MAX_VARIABLES) return fail(session, messageName, id, ERRORS.invalidVariables)
		variables = parsed
	}

	// --- config fields ---
	let configFields
	if (params.CONFIG_FIELDS !== undefined && session.capabilities.configFields) {
		const decoded = decodeJsonParam(String(params.CONFIG_FIELDS))
		const parsed = decoded === undefined ? undefined : SatelliteConfigFieldsSchema.safeParse(decoded)
		if (!parsed?.success || parsed.data.length > MAX_CONFIG_FIELDS) {
			return fail(session, messageName, id, ERRORS.invalidConfigFields)
		}
		configFields = parsed.data
	}

	const pincodeLock = params.PINCODE_LOCK
	const device: Device = {
		id,
		serial,
		serialIsUnique: params.SERIAL_IS_UNIQUE !== undefined ? isTruthy(params.SERIAL_IS_UNIQUE) : true,
		productName: String(params.PRODUCT_NAME),
		connection: session.connection,
		surface,
		bitmapFormat: parseBitmapFormat(params.BITMAP_FORMAT, session.capabilities.bitmapFormats),
		supportsBrightness:
			!session.capabilities.brightnessOptOut || params.BRIGHTNESS === undefined || isTruthy(params.BRIGHTNESS),
		supportsLockedState:
			session.capabilities.pincodeLock && (pincodeLock === 'FULL' || pincodeLock === 'PARTIAL')
				? pincodeLock
				: false,
		canChangePage:
			session.capabilities.changePage && typeof params.CAN_CHANGE_PAGE === 'string' && params.CAN_CHANGE_PAGE
				? params.CAN_CHANGE_PAGE
				: undefined,
		variables,
		configFields,
		addedAt: Date.now(),
		firmwareUpdateUrl: null,
	}

	session.devices.add(device)
	session.events.onDeviceAdded?.(session, device)
	ok(session, messageName, id)
}

const removeDevice: CommandHandler = (context) => {
	const device = requireDevice(context, 'REMOVE-DEVICE')
	if (!device) return
	context.session.devices.remove(device.id)
	context.session.events.onDeviceRemoved?.(context.session, device)
	ok(context.session, 'REMOVE-DEVICE', device.id)
}

/** Resolve the target control for a legacy or advanced input message. */
function resolveControl(context: CommandContext, messageName: string, device: Device): { id: string } | undefined {
	const { session, params } = context

	if (device.surface.fromManifest) {
		if (!params.CONTROLID) {
			fail(session, messageName, device.id, ERRORS.missingControlId)
			return undefined
		}
		const controlId = String(params.CONTROLID)
		if (!device.surface.controls.has(controlId)) {
			fail(session, messageName, device.id, ERRORS.unknownControlId)
			return undefined
		}
		return { id: controlId }
	}

	// A falsey KEY is rejected here, before parseKeyParam — which is what stops `KEY=` resolving to
	// key 0. See the quirk list in docs/protocol.md.
	if (!params.KEY) {
		fail(session, messageName, device.id, ERRORS.missingKey)
		return undefined
	}
	const xy = parseKeyParam(String(params.KEY), device.surface.gridSize)
	if (!xy) {
		fail(session, messageName, device.id, ERRORS.invalidKey)
		return undefined
	}
	const control = controlAt(device.surface, xy[0], xy[1])
	if (!control) {
		fail(session, messageName, device.id, ERRORS.invalidKey)
		return undefined
	}
	return { id: control.id }
}

const keyPress: CommandHandler = (context) => {
	const messageName = 'KEY-PRESS'
	const device = requireDevice(context, messageName)
	if (!device) return

	const control = resolveControl(context, messageName, device)
	if (!control) return

	if (!context.params.PRESSED) return fail(context.session, messageName, device.id, ERRORS.missingPressed)
	const pressed = !isFalsey(context.params.PRESSED)

	context.session.events.onKeyPress?.(context.session, device, control.id, pressed)
	ok(context.session, messageName, device.id)
}

const keyRotate: CommandHandler = (context) => {
	const messageName = 'KEY-ROTATE'
	const { session, params } = context
	const device = requireDevice(context, messageName)
	if (!device) return

	const control = resolveControl(context, messageName, device)
	if (!control) return

	if (!params.DIRECTION) return fail(session, messageName, device.id, ERRORS.missingDirection)
	const delta = parseRotationDelta(params.DIRECTION, session.capabilities.rotaryAmount)

	session.events.onKeyRotate?.(session, device, control.id, delta)
	ok(session, messageName, device.id)
}

const pincodeKey: CommandHandler = (context) => {
	const messageName = 'PINCODE-KEY'
	const device = requireDevice(context, messageName)
	if (!device) return

	const key = context.params.KEY
	if (!key) return fail(context.session, messageName, device.id, ERRORS.missingKey)

	const digit = Number(key)
	if (isNaN(digit) || digit < 0 || digit > 9) return fail(context.session, messageName, device.id, ERRORS.invalidKey)

	context.session.events.onPincodeKey?.(context.session, device, digit)
	ok(context.session, messageName, device.id)
}

const setVariableValue: CommandHandler = (context) => {
	const messageName = 'SET-VARIABLE-VALUE'
	const { session, params } = context
	const device = requireDevice(context, messageName)
	if (!device) return

	const variable = params.VARIABLE
	if (!variable || variable === true) return fail(session, messageName, device.id, ERRORS.missingVariable)

	const encoded = params.VALUE
	if (encoded === undefined || encoded === true) return fail(session, messageName, device.id, ERRORS.missingValue)

	const value = decodeBase64(encoded, MAX_DECODED_JSON_BYTES)
	if (value === undefined) return fail(session, messageName, device.id, ERRORS.missingValue)

	session.events.onVariableValue?.(session, device, variable, value)
	// The variable name is echoed only from 1.7.1.
	ok(session, messageName, device.id, session.capabilities.echoVariableOnOk ? { VARIABLE: variable } : {})
}

const firmwareUpdateInfo: CommandHandler = (context) => {
	const messageName = 'FIRMWARE-UPDATE-INFO'
	const device = requireDevice(context, messageName)
	if (!device) return

	const url = context.params.UPDATE_URL
	if (url === undefined || url === true) return fail(context.session, messageName, device.id, ERRORS.missingUpdateUrl)

	// Stored as inert text and surfaced in the web UI. Never fetched, never linkified — this is the
	// only user-supplied URL the protocol carries, and the no-egress invariant depends on it staying
	// data. See docs/design.md §9.1.
	device.firmwareUpdateUrl = url === '' ? null : url
	context.session.events.onFirmwareUpdateInfo?.(context.session, device, device.firmwareUpdateUrl)
	ok(context.session, messageName, device.id)
}

const changePage: CommandHandler = (context) => {
	const messageName = 'CHANGE-PAGE'
	const device = requireDevice(context, messageName)
	if (!device) return

	if (context.params.DIRECTION === undefined) {
		return fail(context.session, messageName, device.id, ERRORS.missingDirection)
	}
	const forward = isTruthy(context.params.DIRECTION)

	// Companion silently ignores this when the user has disabled page changes, and always answers OK.
	context.session.events.onChangePage?.(context.session, device, forward)
	ok(context.session, messageName, device.id)
}

// --- subscriptions ---

function requireSubscriptions(session: SatelliteSession, messageName: string): boolean {
	if (session.subscriptionsAvailable) return true
	fail(session, messageName, null, ERRORS.subscriptionsNotEnabled)
	return false
}

function parseSubStyle(params: ParsedParams): SatelliteControlStylePreset | undefined {
	if (params.STYLE && params.STYLE !== true) {
		const decoded = decodeJsonParam(String(params.STYLE))
		if (decoded === undefined || typeof decoded !== 'object') return undefined
		return decoded as SatelliteControlStylePreset
	}

	const style: SatelliteControlStylePreset = {}
	if (params.BITMAP !== undefined && !isFalsey(params.BITMAP)) {
		let size = Number(params.BITMAP)
		if (isNaN(size) || size < 5) size = 72
		style.bitmap = { w: size, h: size }
	}
	if (params.COLORS !== undefined && isTruthy(params.COLORS)) {
		style.colors = params.COLORS === 'rgb' ? 'rgb' : 'hex'
	}
	style.text = params.TEXT !== undefined && isTruthy(params.TEXT)
	style.textStyle = params.TEXT_STYLE !== undefined && isTruthy(params.TEXT_STYLE)
	return style
}

const addSub: CommandHandler = (context) => {
	const messageName = 'ADD-SUB'
	const { session, params } = context
	if (!requireSubscriptions(session, messageName)) return

	const subId = params.SUBID
	if (!subId || subId === true) return fail(session, messageName, null, ERRORS.missingSubId)
	const id = String(subId)
	if (!ID_PATTERN.test(id)) return fail(session, messageName, null, ERRORS.invalidSubId)
	if (session.subscriptions.has(id)) return fail(session, messageName, null, ERRORS.subIdAlreadyInUse)
	if (session.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
		return fail(session, messageName, null, 'Too many subscriptions')
	}

	const locationStr = params.LOCATION
	if (!locationStr || locationStr === true) return fail(session, messageName, null, ERRORS.missingLocation)
	const match = LOCATION_PATTERN.exec(String(locationStr))
	if (!match) return fail(session, messageName, null, ERRORS.invalidLocation)

	const style = parseSubStyle(params)
	if (!style) return fail(session, messageName, null, ERRORS.invalidStyle)
	if (!styleWithinLimits(style))
		return fail(session, messageName, null, `Bitmap too large (limit ${MAX_BITMAP_DIMENSION}px)`)

	const subscription = {
		subId: id,
		location: { pageNumber: Number(match[1]), row: Number(match[2]), column: Number(match[3]) },
		style,
		bitmapFormat: parseBitmapFormat(params.BITMAP_FORMAT, session.capabilities.bitmapFormats),
	}
	session.subscriptions.set(id, subscription)

	session.send(buildOk(messageName, null, session.capabilities, { SUBID: id }))

	// Companion pushes the current state straight away — including for a location with no button,
	// which is a valid subscription that simply renders empty.
	session.send(
		buildSubState({
			subId: id,
			values: { pressed: false, type: 'BUTTON' },
			preset: style,
			caps: session.capabilities,
		})
	)
	session.events.onSubscriptionAdded?.(session, subscription)
}

const removeSub: CommandHandler = (context) => {
	const messageName = 'REMOVE-SUB'
	const { session, params } = context
	if (!requireSubscriptions(session, messageName)) return

	const subId = params.SUBID
	if (!subId || subId === true) return fail(session, messageName, null, ERRORS.missingSubId)
	const id = String(subId)
	if (!session.subscriptions.has(id)) return fail(session, messageName, null, ERRORS.unknownSubId)

	session.subscriptions.delete(id)
	session.send(buildOk(messageName, null, session.capabilities, { SUBID: id }))
}

const subPress: CommandHandler = (context) => {
	const messageName = 'SUB-PRESS'
	const { session, params } = context
	if (!requireSubscriptions(session, messageName)) return

	const subId = params.SUBID
	if (!subId || subId === true) return fail(session, messageName, null, ERRORS.missingSubId)
	const id = String(subId)
	const subscription = session.subscriptions.get(id)
	if (!subscription) return fail(session, messageName, null, ERRORS.unknownSubId)

	if (!params.PRESSED) return fail(session, messageName, null, ERRORS.missingPressed)
	session.events.onSubPress?.(session, subscription, !isFalsey(params.PRESSED))
	session.send(buildOk(messageName, null, session.capabilities, { SUBID: id }))
}

const subRotate: CommandHandler = (context) => {
	const messageName = 'SUB-ROTATE'
	const { session, params } = context
	if (!requireSubscriptions(session, messageName)) return

	const subId = params.SUBID
	if (!subId || subId === true) return fail(session, messageName, null, ERRORS.missingSubId)
	const id = String(subId)
	const subscription = session.subscriptions.get(id)
	if (!subscription) return fail(session, messageName, null, ERRORS.unknownSubId)

	if (!params.DIRECTION) return fail(session, messageName, null, ERRORS.missingDirection)
	const delta = parseRotationDelta(params.DIRECTION, session.capabilities.rotaryAmount)
	session.events.onSubRotate?.(session, subscription, delta)
	session.send(buildOk(messageName, null, session.capabilities, { SUBID: id }))
}

/**
 * Commands available at the active capability level.
 *
 * Anything gated by version is filtered here rather than inside the handler, so an older profile
 * answers `Unknown command` exactly as a server of that vintage would, instead of a more helpful
 * error that no real Companion would ever send.
 */
export function buildCommandHandlers(capabilities: {
	keyRotate: boolean
	transferableValues: boolean
	pincodeLock: boolean
	subscriptions: boolean
	changePage: boolean
	firmwareUpdateInfo: boolean
}): Map<string, CommandHandler> {
	const handlers = new Map<string, CommandHandler>([
		['ADD-DEVICE', addDevice],
		['REMOVE-DEVICE', removeDevice],
		['KEY-PRESS', keyPress],
	])

	if (capabilities.keyRotate) handlers.set('KEY-ROTATE', keyRotate)
	if (capabilities.transferableValues) handlers.set('SET-VARIABLE-VALUE', setVariableValue)
	if (capabilities.pincodeLock) handlers.set('PINCODE-KEY', pincodeKey)
	if (capabilities.changePage) handlers.set('CHANGE-PAGE', changePage)
	if (capabilities.firmwareUpdateInfo) handlers.set('FIRMWARE-UPDATE-INFO', firmwareUpdateInfo)
	if (capabilities.subscriptions) {
		handlers.set('ADD-SUB', addSub)
		handlers.set('REMOVE-SUB', removeSub)
		handlers.set('SUB-PRESS', subPress)
		handlers.set('SUB-ROTATE', subRotate)
	}

	return handlers
}
