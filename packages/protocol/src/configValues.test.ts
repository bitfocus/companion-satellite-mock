import { describe, expect, it } from 'vitest'
import { coerceConfigValue, defaultConfigValues, defaultValueFor } from './configValues.js'
import type { ConfigField } from './upstream/SatelliteConfigFieldsSchema.js'

const text: ConfigField = { id: 't', label: 'T', type: 'textinput' }
const number: ConfigField = { id: 'n', label: 'N', type: 'number', min: 5, max: 10 }
const dropdown: ConfigField = {
	id: 'd',
	label: 'D',
	type: 'dropdown',
	choices: [
		{ id: 'a', label: 'A' },
		{ id: 'b', label: 'B' },
	],
}
const checkbox: ConfigField = { id: 'c', label: 'C', type: 'checkbox' }
const staticText: ConfigField = { id: 's', label: 'S', type: 'static-text', value: 'hello' }

describe('defaultValueFor', () => {
	it('uses the declared default when there is one', () => {
		expect(defaultValueFor({ ...text, default: 'x' })).toBe('x')
		expect(defaultValueFor({ ...number, default: 7 })).toBe(7)
		expect(defaultValueFor({ ...checkbox, default: true })).toBe(true)
	})

	it('falls back sensibly when there is none', () => {
		expect(defaultValueFor(text)).toBe('')
		// A number field's minimum is in range; zero might not be.
		expect(defaultValueFor(number)).toBe(5)
		// A dropdown's value should be one of its choices, and the schema guarantees at least one.
		expect(defaultValueFor(dropdown)).toBe('a')
		expect(defaultValueFor(checkbox)).toBe(false)
	})

	it('gives static text no value, rather than inventing one', () => {
		expect(defaultValueFor(staticText)).toBeUndefined()
	})
})

describe('defaultConfigValues', () => {
	it('builds the payload Companion sends right after ADD-DEVICE OK', () => {
		expect(defaultConfigValues([text, number, dropdown, checkbox, staticText])).toEqual({
			t: '',
			n: 5,
			d: 'a',
			c: false,
		})
	})

	it('is empty for no fields', () => {
		expect(defaultConfigValues([])).toEqual({})
	})
})

describe('coerceConfigValue', () => {
	it('accepts a value of the right type', () => {
		expect(coerceConfigValue(text, 'hello')).toBe('hello')
		expect(coerceConfigValue(number, 7)).toBe(7)
		expect(coerceConfigValue(checkbox, true)).toBe(true)
		expect(coerceConfigValue(dropdown, 'b')).toBe('b')
	})

	it('rejects a value of the wrong type, so a number field never receives a string', () => {
		expect(coerceConfigValue(number, 'abc')).toBeUndefined()
		expect(coerceConfigValue(checkbox, 'true')).toBeUndefined()
		expect(coerceConfigValue(text, 42)).toBeUndefined()
	})

	it("enforces a number field's range", () => {
		expect(coerceConfigValue(number, 4)).toBeUndefined()
		expect(coerceConfigValue(number, 11)).toBeUndefined()
		expect(coerceConfigValue(number, 5)).toBe(5)
		expect(coerceConfigValue(number, 10)).toBe(10)
	})

	it('coerces a numeric string, since form inputs produce strings', () => {
		expect(coerceConfigValue(number, '7')).toBe(7)
	})

	it('rejects a dropdown value outside the declared choices', () => {
		expect(coerceConfigValue(dropdown, 'z')).toBeUndefined()
		expect(coerceConfigValue({ ...dropdown, allowCustom: true }, 'z')).toBe('z')
	})

	it('enforces a textinput regex, in both the bare and /…/ forms', () => {
		expect(coerceConfigValue({ ...text, regex: '^\\d+$' }, '123')).toBe('123')
		expect(coerceConfigValue({ ...text, regex: '^\\d+$' }, 'abc')).toBeUndefined()
		expect(coerceConfigValue({ ...text, regex: '/^[a-z]+$/i' }, 'ABC')).toBe('ABC')
	})

	it('ignores an unparseable regex rather than rejecting everything', () => {
		// A malformed pattern comes from the client, and is not a reason to break the operator's UI.
		expect(coerceConfigValue({ ...text, regex: '([' }, 'anything')).toBe('anything')
	})

	it('never produces a value for static text', () => {
		expect(coerceConfigValue(staticText, 'x')).toBeUndefined()
	})
})
