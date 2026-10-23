/**
 * The Satellite API line codec, from Companion's own `@companion-app/satellite-protocol`.
 *
 * Companion's server uses exactly these, so re-exporting them is what keeps the mock's parsing
 * byte-for-byte the same as the real thing — quirks included, see docs/protocol.md §1.
 */
export {
	BANNED_PROPS,
	isFalsey,
	isTruthy,
	parseLineParameters,
	parseStringParamWithBooleanFallback,
	SatelliteLineBuffer,
	splitSatelliteCommand,
	type ParsedParams,
	type SatelliteLineBufferResult,
} from '@companion-app/satellite-protocol/codec'
