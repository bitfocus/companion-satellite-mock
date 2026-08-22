import { describe, expect, it } from 'vitest'
import { parseLineParameters } from './parse.js'

/**
 * A verbatim copy of Companion's `parseLineParameters`, from
 * companion/lib/Resources/Util.ts at commit 3d76cba.
 *
 * This exists so the port can be proven equivalent by differential testing rather than by reading.
 * Do not tidy it — the point is that it is upstream's code, character for character, so that
 * refreshing it against a newer Companion is a copy-paste and any behaviour change shows up as a
 * test failure rather than as a subtle wire difference nobody notices.
 */
const BANNED_PROPS = new Set(['__proto__', 'constructor', 'prototype'])
type UpstreamParams = Record<string, string | true | undefined>

function upstreamParseLineParameters(line: string): UpstreamParams {
	const makeSafe = (index: number) => {
		return index === -1 ? Number.POSITIVE_INFINITY : index
	}

	const fragments = ['']
	let quotes = 0

	let i = 0
	while (i < line.length) {
		const spaceIndex = makeSafe(line.indexOf(' ', i))
		const slashIndex = makeSafe(line.indexOf('\\', i))
		const quoteIndex = makeSafe(line.indexOf('"', i))

		const o = Math.min(spaceIndex, slashIndex, quoteIndex)
		if (!isFinite(o)) {
			const slice = line.substring(i)
			fragments[fragments.length - 1] += slice

			break
		} else {
			const slice = line.substring(i, o)
			fragments[fragments.length - 1] += slice

			const c = line[o]
			if (c == '\\') {
				fragments[fragments.length - 1] += line[o + 1] ?? ''

				i = o + 2
			} else {
				i = o + 1

				if (c === '"') {
					quotes ^= 1
				} else if (!quotes && c === ' ') {
					fragments.push('')
				} else {
					fragments[fragments.length - 1] += c
				}
			}
		}
	}

	const res: UpstreamParams = Object.create(null) as UpstreamParams

	for (const fragment of fragments) {
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

/** Deterministic PRNG so a failing case is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// Weighted towards the characters the parser actually branches on.
const ALPHABET = [...' ', ...'  ', ...'""', ...'\\\\', ...'==', ...'\r\n', ...'abcAB01_-/.:;+', ...'__proto__']

function randomLine(rand: () => number, maxLength: number): string {
	const length = Math.floor(rand() * maxLength)
	let out = ''
	for (let i = 0; i < length; i++) {
		out += ALPHABET[Math.floor(rand() * ALPHABET.length)]
	}
	return out
}

describe('parseLineParameters vs upstream', () => {
	it.each([
		'',
		' ',
		'A=1',
		'A=1 B=2',
		'A',
		'A= B=2',
		'=1',
		'A=="x"',
		'KEY="1"2',
		'TEXT="a\\"b"',
		'TEXT=a\\',
		'"unterminated',
		'A=1  B=2   ',
		'__proto__=x A=1',
		'constructor A=1',
		'VALUE=YWJjZA==',
		'BITMAP=data:image/png;base64,iVBORw0KGgo=',
		'A=1\rB=2',
		'PRODUCT_NAME="Satellite Streamdeck" KEYS_TOTAL=32',
		'\\ \\ \\',
		'""""',
		'a"b c"d=1',
	])('matches on %j', (line) => {
		expect({ ...parseLineParameters(line) }).toEqual({ ...upstreamParseLineParameters(line) })
	})

	it('matches on 20000 random lines', () => {
		const rand = mulberry32(0x5a71e11e)
		for (let i = 0; i < 20000; i++) {
			const line = randomLine(rand, 60)
			const ours = { ...parseLineParameters(line) }
			const theirs = { ...upstreamParseLineParameters(line) }
			// Compare inline rather than via expect() per iteration, so a failure reports the line.
			if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
				throw new Error(
					`divergence on ${JSON.stringify(line)}\n  ours:   ${JSON.stringify(ours)}\n  theirs: ${JSON.stringify(theirs)}`
				)
			}
		}
	})
})
