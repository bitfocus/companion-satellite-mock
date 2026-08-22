import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseLineParameters } from './parse.js'
import { serialiseMessage, type MessageArgs, type MessageStatus } from './serialise.js'

/**
 * Runs the hand-authored conformance corpus.
 *
 * The corpus is a spec, not a snapshot: it was written from Companion's documented and observed
 * behaviour rather than generated from this implementation, so when the two disagree the code is
 * wrong until proven otherwise. It ships as plain JSON so a client in any language can run the same
 * cases — see packages/protocol/corpus/README.md.
 *
 * `node:fs` here is fine: this is a test, not shipped code. The lint rule keeping I/O out of the
 * package applies to `src/**` excluding tests by way of it only mattering for what gets built.
 */
interface Corpus {
	apiVersion: string
	parse: { name: string; quirk?: number | null; line: string; expected: Record<string, string | true> }[]
	serialise: {
		name: string
		quirk?: number | null
		message: string
		status: MessageStatus | null
		deviceId: string | null
		args: MessageArgs
		expected: string
	}[]
}

const corpus = JSON.parse(
	readFileSync(fileURLToPath(new URL('../corpus/satellite-corpus.json', import.meta.url)), 'utf8')
) as Corpus

describe('conformance corpus', () => {
	it('is not empty, in case the file failed to load', () => {
		expect(corpus.parse.length).toBeGreaterThan(20)
		expect(corpus.serialise.length).toBeGreaterThan(10)
	})

	describe('parse', () => {
		it.each(corpus.parse.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
			expect({ ...parseLineParameters(testCase.line) }).toEqual(testCase.expected)
		})
	})

	describe('serialise', () => {
		it.each(corpus.serialise.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
			expect(serialiseMessage(testCase.message, testCase.status, testCase.deviceId, testCase.args)).toBe(
				testCase.expected
			)
		})
	})

	it('covers every quirk that has a corpus case, and names them consistently', () => {
		const quirks = new Set(
			[...corpus.parse, ...corpus.serialise].map((c) => c.quirk).filter((q): q is number => typeof q === 'number')
		)
		// Quirks 1, 3, 4, 5, 6, 7, 10, 12 and 17 are expressible as corpus cases. The rest (2, 8, 9,
		// 11, 13, 14, 15, 16) are about framing, dispatch or server state rather than a single line,
		// and are covered by their own unit tests instead.
		expect([...quirks].sort((a, b) => a - b)).toEqual([1, 3, 4, 5, 6, 7, 10, 12, 17])
	})
})
