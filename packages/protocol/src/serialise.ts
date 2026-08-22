export type MessageArgs = Record<string, string | number | boolean>

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
 * Values are not escaped, matching upstream: strings are wrapped in quotes and the caller is
 * responsible for not putting a `"` or newline inside one. `assertSafeValue` exists for callers
 * handling untrusted input (the raw sender in the web UI).
 */
export function serialiseMessage(
	messageName: string,
	status: MessageStatus | null,
	deviceId: string | null,
	args: MessageArgs = {},
	options: SerialiseOptions = {}
): string {
	const { trailingSpace = true, lineEnding = '\n' } = options

	const chunks: string[] = [messageName]
	if (status) chunks.push(status)
	if (deviceId) chunks.push(`DEVICEID="${deviceId}"`)

	for (const [key, value] of Object.entries(args)) {
		let valueStr: string
		if (typeof value === 'boolean') {
			valueStr = value ? '1' : '0'
		} else if (typeof value === 'number') {
			valueStr = value.toString()
		} else {
			valueStr = `"${value}"`
		}
		chunks.push(`${key}=${valueStr}`)
	}

	if (trailingSpace) {
		chunks.push(lineEnding)
		return chunks.join(' ')
	}
	return chunks.join(' ') + lineEnding
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
 * Whether a value can be safely placed in a message without corrupting the line.
 *
 * Upstream does no escaping, so a value containing a quote or a newline produces a line that parses
 * back as something else entirely. Anything accepting operator input must check this first.
 */
export function isSafeValue(value: string): boolean {
	return !/["\r\n]/.test(value)
}
