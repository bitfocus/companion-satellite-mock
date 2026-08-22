import { describe, expect, it } from 'vitest'
import { isSafeValue, serialiseError, serialiseMessage } from './serialise.js'
import { parseLineParameters, splitCommand } from './parse.js'

describe('serialiseMessage', () => {
	it('quirk 1: emits a trailing space before the newline, as upstream does', () => {
		expect(serialiseMessage('KEY-STATE', null, 'dev1', { KEY: 0 })).toBe('KEY-STATE DEVICEID="dev1" KEY=0 \n')
	})

	it('can drop the trailing space, for the chaos tool', () => {
		expect(serialiseMessage('KEY-STATE', null, 'dev1', { KEY: 0 }, { trailingSpace: false })).toBe(
			'KEY-STATE DEVICEID="dev1" KEY=0\n'
		)
	})

	it('can emit CRLF', () => {
		expect(serialiseMessage('PONG', null, null, {}, { lineEnding: '\r\n' })).toBe('PONG \r\n')
		expect(serialiseMessage('PONG', null, null, {}, { lineEnding: '\r\n', trailingSpace: false })).toBe('PONG\r\n')
	})

	it('quirk 7: emits booleans as 1/0', () => {
		expect(serialiseMessage('X', null, null, { A: true, B: false })).toBe('X A=1 B=0 \n')
	})

	it('emits numbers bare and strings quoted', () => {
		expect(serialiseMessage('X', null, null, { N: 42, S: 'hi' })).toBe('X N=42 S="hi" \n')
	})

	it('emits the status when given', () => {
		expect(serialiseMessage('ADD-DEVICE', 'OK', 'dev1', {})).toBe('ADD-DEVICE OK DEVICEID="dev1" \n')
	})

	it('omits DEVICEID when null', () => {
		expect(serialiseMessage('ERROR', null, null, { MESSAGE: 'Unknown command: NOPE' })).toBe(
			'ERROR MESSAGE="Unknown command: NOPE" \n'
		)
	})

	it('preserves argument order', () => {
		expect(serialiseMessage('X', null, null, { B: 1, A: 2 })).toBe('X B=1 A=2 \n')
	})

	it('handles the BEGIN handshake', () => {
		expect(serialiseMessage('BEGIN', null, null, { CompanionVersion: '5.1.0', ApiVersion: '1.14.0' })).toBe(
			'BEGIN CompanionVersion="5.1.0" ApiVersion="1.14.0" \n'
		)
	})
})

describe('serialiseError', () => {
	it('quirk 10: reproduces the doubled token of the line-too-long error', () => {
		expect(serialiseError('ERROR', null, 'Line too long')).toBe('ERROR ERROR MESSAGE="Line too long" \n')
	})

	it('includes DEVICEID when known', () => {
		expect(serialiseError('KEY-PRESS', 'dev1', 'Device not found')).toBe(
			'KEY-PRESS ERROR DEVICEID="dev1" MESSAGE="Device not found" \n'
		)
	})
})

describe('round trip', () => {
	it('parses back what it serialised', () => {
		const line = serialiseMessage('KEY-STATE', null, 'streamdeck:12345', {
			KEY: 4,
			PRESSED: true,
			TYPE: 'BUTTON',
			TEXT: 'SGVsbG8gd29ybGQ=',
			COLOR: '#00ff00',
		})
		const { command, body } = splitCommand(line.trimEnd())
		expect(command).toBe('KEY-STATE')
		expect({ ...parseLineParameters(body) }).toEqual({
			DEVICEID: 'streamdeck:12345',
			KEY: '4',
			PRESSED: '1',
			TYPE: 'BUTTON',
			TEXT: 'SGVsbG8gd29ybGQ=',
			COLOR: '#00ff00',
		})
	})

	it('quirk 16: a value containing a quote corrupts the line, which is why isSafeValue exists', () => {
		const line = serialiseMessage('X', null, null, { TEXT: 'a"b c' })
		const { body } = splitCommand(line.trimEnd())
		// The quote re-opens quoting, swallowing the space — the value does not survive.
		expect(parseLineParameters(body).TEXT).not.toBe('a"b c')

		expect(isSafeValue('a"b')).toBe(false)
		expect(isSafeValue('a\nb')).toBe(false)
		expect(isSafeValue('a\rb')).toBe(false)
		expect(isSafeValue('perfectly fine')).toBe(true)
	})
})
