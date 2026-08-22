import { describe, expect, it } from 'vitest'
import { BANNED_PROPS } from './constants.js'
import { parseLineParameters } from './parse.js'

/**
 * Pins the prototype-pollution guard list against upstream.
 *
 * This exists because the first version of the port had three of the seven entries, and the
 * differential test could not see it: the fixture had been given *our* set rather than upstream's,
 * so both sides were wrong in the same way. A copied constant needs its own pin, separate from any
 * test that shares it.
 */
describe('BANNED_PROPS', () => {
	it('matches @companion-app/expressions exactly', () => {
		expect([...BANNED_PROPS].sort()).toEqual(
			[
				'__defineGetter__',
				'__defineSetter__',
				'__lookupGetter__',
				'__lookupSetter__',
				'__proto__',
				'constructor',
				'prototype',
			].sort()
		)
	})

	it.each([...BANNED_PROPS])('drops %s as a key', (prop) => {
		expect({ ...parseLineParameters(`${prop}=x SAFE=1`) }).toEqual({ SAFE: '1' })
	})

	it.each([...BANNED_PROPS])('drops %s as a bare flag', (prop) => {
		expect({ ...parseLineParameters(`${prop} SAFE=1`) }).toEqual({ SAFE: '1' })
	})

	it('still allows them as values', () => {
		expect(parseLineParameters('TEXT=__proto__').TEXT).toBe('__proto__')
	})
})
