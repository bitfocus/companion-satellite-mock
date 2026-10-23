import { describe, expect, it } from 'vitest'
import {
	isFalsey,
	isTruthy,
	parseLineParameters,
	parseStringParamWithBooleanFallback,
	SatelliteLineBuffer,
	splitSatelliteCommand,
} from './parse.js'

/*
 * These test Companion's own codec, re-exported from @companion-app/satellite-protocol. They pin the
 * quirks docs/protocol.md lists, so a release of that package that changes one fails here rather
 * than quietly changing what clients see.
 */

describe('parseLineParameters', () => {
	it('parses simple key=value pairs', () => {
		expect({ ...parseLineParameters('DEVICEID=00000 KEY=0 PRESSED=true') }).toEqual({
			DEVICEID: '00000',
			KEY: '0',
			PRESSED: 'true',
		})
	})

	it('keeps quoted values containing spaces together', () => {
		expect({ ...parseLineParameters('PRODUCT_NAME="Satellite Streamdeck" KEY=1') }).toEqual({
			PRODUCT_NAME: 'Satellite Streamdeck',
			KEY: '1',
		})
	})

	// --- quirks, docs/protocol.md §1 ---

	it('quirk 3: splits on the first = only, so base64 padding survives', () => {
		const params = parseLineParameters('VALUE=YWJjZA== OTHER=1')
		expect(params.VALUE).toBe('YWJjZA==')
		expect(params.OTHER).toBe('1')
	})

	it('quirk 3: keeps a data: url intact', () => {
		const url = 'data:image/png;base64,iVBORw0KGgo='
		expect(parseLineParameters(`BITMAP=${url}`).BITMAP).toBe(url)
	})

	it('quirk 4: strips quotes anywhere in a fragment, not just at the ends', () => {
		expect(parseLineParameters('KEY="1"2').KEY).toBe('12')
		expect(parseLineParameters('KEY=a"b c"d').KEY).toBe('ab cd')
	})

	it('quirk 5: a backslash escapes the following character', () => {
		expect(parseLineParameters('TEXT="a\\"b"').TEXT).toBe('a"b')
		expect(parseLineParameters('TEXT=a\\ b').TEXT).toBe('a b')
		expect(parseLineParameters('TEXT=a\\\\b').TEXT).toBe('a\\b')
	})

	it('quirk 5: a trailing backslash consumes nothing and terminates cleanly', () => {
		expect(parseLineParameters('TEXT=a\\').TEXT).toBe('a')
	})

	it('quirk 6: a fragment with no = becomes true', () => {
		expect(parseLineParameters('SOMEFLAG').SOMEFLAG).toBe(true)
		expect({ ...parseLineParameters('A B=1') }).toEqual({ A: true, B: '1' })
	})

	it('skips empty fragments from runs of spaces', () => {
		expect({ ...parseLineParameters('  A=1   B=2  ') }).toEqual({ A: '1', B: '2' })
	})

	it('ignores a fragment with an empty key', () => {
		expect({ ...parseLineParameters('=value A=1') }).toEqual({ A: '1' })
	})

	it('quirk 18: drops prototype-polluting keys and returns a null-prototype object', () => {
		const params = parseLineParameters('__proto__=x constructor=y prototype=z SAFE=1')
		expect({ ...params }).toEqual({ SAFE: '1' })
		expect(Object.getPrototypeOf(params)).toBeNull()
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})

	it('returns the last value when a key repeats', () => {
		expect(parseLineParameters('KEY=1 KEY=2').KEY).toBe('2')
	})

	it('handles an empty line', () => {
		expect({ ...parseLineParameters('') }).toEqual({})
	})

	it('accepts an unterminated quote, taking the remainder verbatim', () => {
		expect(parseLineParameters('TEXT="abc def').TEXT).toBe('abc def')
	})
})

describe('SatelliteLineBuffer', () => {
	it('quirk 2: strips only a trailing carriage return', () => {
		const buffer = new SatelliteLineBuffer(1024)
		expect(buffer.push('A=1\r\nB=\r2\n').lines).toEqual(['A=1', 'B=\r2'])
	})

	it('splits lines however the data arrives', () => {
		const buffer = new SatelliteLineBuffer(1024)
		expect(buffer.push('A=1\nB=').lines).toEqual(['A=1'])
		expect(buffer.push('2\n').lines).toEqual(['B=2'])
	})

	it('reports a complete line over the limit, not just an unterminated one', () => {
		expect(new SatelliteLineBuffer(4).push('ABCDEFG\n').overflow).toBe(true)
		expect(new SatelliteLineBuffer(4).push('ABCDEFG').overflow).toBe(true)
	})
})

describe('splitSatelliteCommand', () => {
	it('splits on the first space', () => {
		expect(splitSatelliteCommand('KEY-PRESS DEVICEID=1 KEY=0')).toEqual({
			command: 'KEY-PRESS',
			body: 'DEVICEID=1 KEY=0',
		})
	})

	it('handles a command with no arguments', () => {
		expect(splitSatelliteCommand('QUIT')).toEqual({ command: 'QUIT', body: '' })
	})

	it('quirk 8: leaves a PING payload completely unparsed', () => {
		expect(splitSatelliteCommand('PING some "arbitrary" payload=x').body).toBe('some "arbitrary" payload=x')
	})
})

describe('isFalsey / isTruthy', () => {
	it.each(['false', 'FALSE', 'False', '0', '', undefined, null, 0, false])('treats %o as falsey', (v) => {
		expect(isFalsey(v)).toBe(true)
		expect(isTruthy(v)).toBe(false)
	})

	it.each(['true', 'TRUE', 'yes', 'YES', '1', '2', 1, true])('treats %o as truthy', (v) => {
		expect(isTruthy(v)).toBe(true)
		expect(isFalsey(v)).toBe(false)
	})

	it('treats an arbitrary string as neither truthy nor falsey', () => {
		// Not simply !isFalsey — this asymmetry is load-bearing for optional params.
		expect(isFalsey('banana')).toBe(false)
		expect(isTruthy('banana')).toBe(false)
	})
})

describe('parseStringParamWithBooleanFallback', () => {
	const list = ['hex', 'rgb'] as const

	it('returns an exact match', () => {
		expect(parseStringParamWithBooleanFallback(list, 'hex', 'rgb')).toBe('rgb')
	})

	it('falls back to the default for a truthy value', () => {
		expect(parseStringParamWithBooleanFallback(list, 'hex', 'true')).toBe('hex')
		expect(parseStringParamWithBooleanFallback(list, 'hex', '1')).toBe('hex')
	})

	it('returns null for a falsey value', () => {
		expect(parseStringParamWithBooleanFallback(list, 'hex', 'false')).toBeNull()
		expect(parseStringParamWithBooleanFallback(list, 'hex', undefined)).toBeNull()
	})
})
