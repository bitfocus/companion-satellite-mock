import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parseLineParameters, splitSatelliteCommand } from './parse.js'
import { serialiseMessage, type MessageArgs, type MessageStatus } from './serialise.js'

/**
 * Runs Companion's official conformance corpus, shipped in @companion-app/satellite-protocol,
 * through this package's parser and serialiser.
 *
 * The codec itself is Companion's, so this mostly checks that `serialiseMessage` — which wraps it
 * to add the chaos tool's framing options — sends exactly what Companion sends when those options
 * are off. Any client, in any language, can run the same file against its own codec.
 *
 * `node:fs` here is fine: this is a test, not shipped code.
 */
interface Corpus {
	parse: { name: string; line: string; expected: Record<string, string | true> }[]
	format: {
		name: string
		message: string
		status: MessageStatus | null
		deviceId: string | null
		args: MessageArgs
		expected: string
	}[]
	formatErrors: { name: string; deviceId: string | null; args: MessageArgs }[]
	roundTrip: string[]
}

const path = createRequire(import.meta.url).resolve(
	'@companion-app/satellite-protocol/assets/satellite-protocol-corpus.json'
)
const corpus = JSON.parse(readFileSync(path, 'utf8')) as Corpus

describe("Companion's conformance corpus", () => {
	it('is not empty, in case the file failed to load', () => {
		expect(corpus.parse.length).toBeGreaterThan(10)
		expect(corpus.format.length).toBeGreaterThan(0)
	})

	it.each(corpus.parse.map((c) => [c.name, c] as const))('parses: %s', (_name, c) => {
		expect({ ...parseLineParameters(c.line) }).toEqual(c.expected)
	})

	it.each(corpus.format.map((c) => [c.name, c] as const))('formats: %s', (_name, c) => {
		expect(serialiseMessage(c.message, c.status, c.deviceId, c.args)).toBe(c.expected)
	})

	it.each(corpus.formatErrors.map((c) => [c.name, c] as const))('refuses: %s', (_name, c) => {
		expect(() => serialiseMessage('X', null, c.deviceId, c.args)).toThrow()
	})

	it.each(corpus.roundTrip.map((value) => [JSON.stringify(value), value] as const))(
		'round-trips %s',
		(_label, value) => {
			const { body } = splitSatelliteCommand(serialiseMessage('X', null, null, { V: value }).trimEnd())
			expect(parseLineParameters(body).V).toBe(value)
		}
	)
})
