/**
 * Constants for Companion's satellite service.
 *
 * The protocol's own come from `@companion-app/satellite-protocol`, under the names this package
 * has always used. The rest mirror upstream rather than picking nicer values — the mock's job is to
 * behave like the real thing. Where the *server* wants tighter limits for abuse resistance, those live in
 * `@satellite-mock/server`, layered on top of these. See docs/protocol.md §2.
 */

export {
	/** The newest API version this package can speak. */
	API_VERSION as SUPPORTED_API_VERSION,
	/**
	 * Upstream's receive-buffer cap, after which the connection is dropped.
	 * The server defaults to something much smaller; this is the compatibility value.
	 */
	MAX_LINE_LENGTH as UPSTREAM_MAX_LINE_LENGTH,
	MAX_KEYS_TOTAL,
	MAX_KEYS_PER_ROW,
	/** Bitmap encodings, in the order upstream advertises them. `rgb` is always the fallback. */
	SATELLITE_BITMAP_FORMATS as BITMAP_FORMATS,
	type SatelliteBitmapFormat as BitmapFormat,
} from '@companion-app/satellite-protocol/constants'

export const LEGACY_MAX_BUTTONS = 32
export const LEGACY_BUTTONS_PER_ROW = 8

/** `BITMAPS` values below this are treated as a boolean, meaning the legacy 72px size. */
export const LEGACY_BITMAP_SIZE = 72
export const MIN_BITMAP_SIZE_PARAM = 5

/** Device id prefixes Companion reserves for its own surfaces. */
export const RESERVED_ID_PREFIXES = ['emulator:', 'group:'] as const

/** Both `SUBID` and advanced-mode control ids use this charset. */
export const ID_PATTERN = /^[a-zA-Z0-9\-/]+$/
export const LOCATION_PATTERN = /^(\d+)\/(\d+)\/(\d+)$/

/**
 * Error strings, verbatim from upstream. Exported as a frozen record so that a typo becomes a
 * compile error rather than a silently divergent wire message.
 */
export const ERRORS = {
	missingDeviceId: 'Missing DEVICEID',
	missingProductName: 'Missing PRODUCT_NAME',
	reservedDeviceId: 'Reserved DEVICEID',
	reservedSerial: 'Reserved SERIAL',
	deviceAlreadyAdded: 'Device already added',
	deviceExistsElsewhere: 'Device exists elsewhere',
	invalidLayoutManifest: 'Invalid LAYOUT_MANIFEST',
	invalidKeysTotal: 'Invalid KEYS_TOTAL',
	invalidKeysPerRow: 'Invalid KEYS_PER_ROW',
	invalidVariables: 'Invalid VARIABLES',
	invalidConfigFields: 'Invalid CONFIG_FIELDS',
	deviceNotFound: 'Device not found',
	missingKey: 'Missing KEY',
	invalidKey: 'Invalid KEY',
	missingPressed: 'Missing PRESSED',
	missingControlId: 'Missing CONTROLID',
	unknownControlId: 'Unknown CONTROLID',
	missingDirection: 'Missing DIRECTION',
	missingVariable: 'Missing VARIABLE',
	missingValue: 'Missing VALUE',
	missingUpdateUrl: 'Missing UPDATE_URL',
	subscriptionsNotEnabled: 'Subscriptions not enabled',
	missingSubId: 'Missing SUBID',
	invalidSubId: 'Invalid SUBID',
	subIdAlreadyInUse: 'SUBID already in use',
	unknownSubId: 'Unknown SUBID',
	missingLocation: 'Missing LOCATION',
	invalidLocation: 'Invalid LOCATION',
	invalidStyle: 'Invalid STYLE',
	lineTooLong: 'Line too long',
} as const satisfies Record<string, string>

export const unknownCommandError = (command: string): string => `Unknown command: ${command}`
