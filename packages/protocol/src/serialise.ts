import { formatSatelliteMessage, type SatelliteMessageArgs } from '@companion-app/satellite-protocol/codec'

export type MessageArgs = SatelliteMessageArgs

export type MessageStatus = 'OK' | 'ERROR'

export interface SerialiseOptions {
	/**
	 * Upstream builds a line by joining its chunks with a space and pushing the newline as the final
	 * chunk, so every line it emits ends with a space before the terminator. Reproducing that by
	 * default is the whole point of this mock; the chaos tool turns it off to check clients aren't
	 * relying on it either way.
	 */
	trailingSpace?: boolean
	/** Upstream always emits `\n`; `\r\n` is a chaos knob, since the spec permits clients to send it. */
	lineEnding?: '\n' | '\r\n'
}

/**
 * Build an outbound Satellite API line, byte-for-byte as Companion would.
 *
 * Companion's own `formatSatelliteMessage` does the work, so quoting and escaping match exactly:
 * strings are quoted with `\` and `"` escaped, and a value that cannot be represented (a newline in
 * it, a key that isn't a plain identifier) throws rather than producing a line that parses back as
 * something else. The options only apply the chaos tool's two framing variations on top.
 */
export function serialiseMessage(
	messageName: string,
	status: MessageStatus | null,
	deviceId: string | null,
	args: MessageArgs = {},
	options: SerialiseOptions = {}
): string {
	const { trailingSpace = true, lineEnding = '\n' } = options

	let line = formatSatelliteMessage(messageName, status, deviceId, args)
	if (!trailingSpace) line = line.replace(/ \n$/, '\n')
	if (lineEnding !== '\n') line = line.replace(/\n$/, lineEnding)
	return line
}

/** Build an error response: `NAME ERROR [DEVICEID="…"] MESSAGE="…"`. */
export function serialiseError(
	messageName: string,
	deviceId: string | null,
	message: string,
	options?: SerialiseOptions
): string {
	return serialiseMessage(messageName, 'ERROR', deviceId, { MESSAGE: message }, options)
}

/**
 * Whether a raw line from the web UI can be sent as-is.
 *
 * The raw sender writes the operator's text straight onto the wire, with no formatter to escape
 * anything, so it refuses what would end the line early or leave a quote unbalanced.
 */
export function isSafeValue(value: string): boolean {
	return !/["\r\n]/.test(value)
}
