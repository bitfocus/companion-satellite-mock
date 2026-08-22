import { BANNED_PROPS } from './constants.js'

/** A parsed parameter is either a string value, or `true` for a bare flag. */
export type ParsedParams = Record<string, string | true | undefined>

/**
 * Parse the parameter portion of a Satellite API line.
 *
 * A faithful port of Companion's `parseLineParameters`, quirks included — see docs/protocol.md §1.
 * The quirks are not incidental: clients in the wild depend on them, so "fixing" any of them here
 * would make the mock a worse test target than the real server.
 */
export function parseLineParameters(line: string): ParsedParams {
	const makeSafe = (index: number): number => (index === -1 ? Number.POSITIVE_INFINITY : index)

	const fragments: string[] = ['']
	let quotes = 0

	// `noUncheckedIndexedAccess` makes upstream's `fragments[fragments.length - 1] += …` awkward to
	// express directly, so the tail is tracked explicitly. Behaviour is identical, and the
	// differential test against upstream in parse.upstream.test.ts is what proves it.
	const append = (text: string): void => {
		fragments[fragments.length - 1] = (fragments[fragments.length - 1] ?? '') + text
	}

	let i = 0
	while (i < line.length) {
		const spaceIndex = makeSafe(line.indexOf(' ', i))
		const slashIndex = makeSafe(line.indexOf('\\', i))
		const quoteIndex = makeSafe(line.indexOf('"', i))

		const o = Math.min(spaceIndex, slashIndex, quoteIndex)
		if (!isFinite(o)) {
			// Nothing of interest left; take the remainder verbatim.
			append(line.substring(i))
			break
		}

		append(line.substring(i, o))

		// `charAt` rather than indexing: `o` is always a valid index here, and this keeps the type
		// a plain string.
		const c = line.charAt(o)
		if (c === '\\') {
			// A backslash escapes whatever follows it, wherever it appears.
			append(line[o + 1] ?? '')
			i = o + 2
		} else {
			i = o + 1
			if (c === '"') {
				// Quotes toggle quoting state and are themselves discarded — including mid-fragment,
				// so `KEY="1"2` parses to `12`.
				quotes ^= 1
			} else if (!quotes && c === ' ') {
				fragments.push('')
			} else {
				append(c)
			}
		}
	}

	const res: ParsedParams = Object.create(null) as ParsedParams

	for (const fragment of fragments) {
		// Split on the FIRST `=` only: the rest of the value is kept intact, so base64 padding and
		// `data:` urls survive.
		const splitIndex = fragment.indexOf('=')
		if (splitIndex === -1) {
			if (fragment === '' || BANNED_PROPS.has(fragment)) continue
			res[fragment] = true
		} else {
			const key = fragment.substring(0, splitIndex)
			if (key === '' || BANNED_PROPS.has(key)) continue
			res[key] = fragment.substring(splitIndex + 1)
		}
	}

	return res
}

/** Split a line into its command name and the unparsed remainder. */
export function splitCommand(line: string): { command: string; body: string } {
	const i = line.indexOf(' ')
	return i === -1 ? { command: line, body: '' } : { command: line.slice(0, i), body: line.slice(i + 1) }
}

/**
 * Normalise an inbound line the way upstream does.
 *
 * Note it strips only the FIRST `\r`, not all of them — a quirk, but a load-bearing one if a client
 * ever sends a stray carriage return mid-line.
 */
export function normaliseLine(line: string): string {
	return line.replace(/\r/, '')
}

/** Companion's notion of a falsey protocol value. */
export const isFalsey = (val: unknown): boolean =>
	(typeof val === 'string' && val.toLowerCase() === 'false') || val === '0' || !val

/**
 * Companion's notion of a truthy protocol value. Note `yes` counts, and that this is not simply
 * `!isFalsey` — a string like `banana` is neither truthy nor falsey.
 */
export const isTruthy = (val: unknown): boolean =>
	!isFalsey(val) &&
	((typeof val === 'string' && (val.toLowerCase() === 'true' || val.toLowerCase() === 'yes')) || Number(val) >= 1)

/**
 * Resolve a parameter that may be one of a set of strings, falling back to a default when it is
 * merely truthy, or `null` when falsey. Used for `COLORS=true|hex|rgb`.
 */
export function parseStringParamWithBooleanFallback<T extends string>(
	list: readonly T[],
	defaultVal: T,
	parameter: unknown
): T | null {
	const param = String(parameter) as T
	if (list.includes(param)) return param
	if (isTruthy(parameter)) return defaultVal
	return null
}
