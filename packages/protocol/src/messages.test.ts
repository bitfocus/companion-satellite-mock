import { describe, expect, it } from 'vitest'
import {
	buildBegin,
	buildBrightness,
	buildCaps,
	buildDeviceConfig,
	buildErrorResponse,
	buildKeyState,
	buildKeysClear,
	buildLockedState,
	buildOk,
	buildPong,
	buildStyleArgs,
	buildSubState,
	buildVariableValue,
	decodeBase64,
	decodedBase64Length,
	type ControlStyleValues,
} from './messages.js'
import { capabilitiesFor } from './versions.js'
import { ERRORS } from './constants.js'

const latest = capabilitiesFor('1.14.0')
const handshake = { companionVersion: '5.1.0' }

const values: ControlStyleValues = {
	pressed: true,
	type: 'BUTTON',
	bitmap: 'AAECAw==',
	color: '#00ff00',
	textColor: '#ffffff',
	text: 'CAM 1',
	fontSize: 14,
	leds: 'BAUG',
}
const fullPreset = {
	bitmap: { w: 72, h: 72 },
	colors: 'hex' as const,
	text: true,
	textStyle: true,
	leds: { segments: 8, mode: 'simple' as const },
}

describe('handshake', () => {
	it('sends BEGIN then CAPS at 1.14', () => {
		expect(buildBegin(latest, handshake)).toBe('BEGIN CompanionVersion="5.1.0" ApiVersion="1.14.0" \n')
		expect(buildCaps(latest, handshake)).toBe(
			'CAPS SUBSCRIPTIONS=1 NONSQUARE=1 BITMAP_FORMATS="rgb,png,webp" ROTARY_AMOUNT=1 \n'
		)
	})

	it('sends no CAPS at all before 1.10', () => {
		expect(buildCaps(capabilitiesFor('1.9.0'), handshake)).toBeNull()
	})

	it('reports SUBSCRIPTIONS=0 when the version supports them but the operator disabled them', () => {
		const line = buildCaps(latest, { ...handshake, subscriptionsEnabled: false })
		expect(line).toContain('SUBSCRIPTIONS=0')
	})

	it('honours a narrowed bitmap format list, for testing client fallback', () => {
		expect(buildCaps(latest, { ...handshake, bitmapFormats: ['rgb'] })).toContain('BITMAP_FORMATS="rgb"')
	})

	it('omits the 1.11+ flags at 1.10', () => {
		const line = buildCaps(capabilitiesFor('1.10.0'), handshake)
		expect(line).toBe('CAPS SUBSCRIPTIONS=1 \n')
	})
})

describe('buildStyleArgs', () => {
	it('includes everything the preset asks for at the latest version', () => {
		expect(buildStyleArgs(values, fullPreset, latest)).toEqual({
			PRESSED: true,
			TYPE: 'BUTTON',
			BITMAP: 'AAECAw==',
			COLOR: '#00ff00',
			TEXTCOLOR: '#ffffff',
			TEXT: 'Q0FNIDE=',
			FONT_SIZE: 14,
			LEDS: 'BAUG',
		})
	})

	it('omits anything the preset did not ask for', () => {
		expect(buildStyleArgs(values, { colors: 'hex' }, latest)).toEqual({
			PRESSED: true,
			TYPE: 'BUTTON',
			COLOR: '#00ff00',
			TEXTCOLOR: '#ffffff',
		})
	})

	it('drops TEXTCOLOR before 1.6 but keeps COLOR', () => {
		const args = buildStyleArgs(values, fullPreset, capabilitiesFor('1.5.1'))
		expect(args['COLOR']).toBe('#00ff00')
		expect(args).not.toHaveProperty('TEXTCOLOR')
	})

	it('drops TYPE and PRESSED before 1.1', () => {
		const args = buildStyleArgs(values, fullPreset, capabilitiesFor('1.0.0'))
		expect(args).not.toHaveProperty('TYPE')
		expect(args).not.toHaveProperty('PRESSED')
	})

	it('drops FONT_SIZE before 1.4 and LEDS before 1.13', () => {
		const at1_3 = buildStyleArgs(values, fullPreset, capabilitiesFor('1.3.0'))
		expect(at1_3).not.toHaveProperty('FONT_SIZE')
		expect(at1_3).not.toHaveProperty('LEDS')

		const at1_12 = buildStyleArgs(values, fullPreset, capabilitiesFor('1.12.0'))
		expect(at1_12).toHaveProperty('FONT_SIZE')
		expect(at1_12).not.toHaveProperty('LEDS')
	})

	it('base64 encodes text so callers cannot forget to', () => {
		const args = buildStyleArgs({ ...values, text: 'a "quote" and\na newline' }, { text: true }, latest)
		expect(decodeBase64(String(args['TEXT']), 1024)).toBe('a "quote" and\na newline')
	})

	it('passes FONT_SIZE=auto through as a string', () => {
		expect(buildStyleArgs({ ...values, fontSize: 'auto' }, fullPreset, latest)['FONT_SIZE']).toBe('auto')
	})
})

describe('buildKeyState', () => {
	const base = { deviceId: 'dev1', values, preset: { colors: 'hex' as const }, caps: latest }

	it('uses KEY in legacy mode', () => {
		expect(buildKeyState({ ...base, key: 4 })).toBe(
			'KEY-STATE DEVICEID="dev1" KEY=4 PRESSED=1 TYPE="BUTTON" COLOR="#00ff00" TEXTCOLOR="#ffffff" \n'
		)
	})

	it('uses CONTROLID in advanced mode', () => {
		expect(buildKeyState({ ...base, controlId: 'enc/0' })).toContain('CONTROLID="enc/0"')
	})

	it('includes LOCATION from 1.10 and omits it before', () => {
		expect(buildKeyState({ ...base, key: 0, location: '3/1/0' })).toContain('LOCATION="3/1/0"')
		expect(buildKeyState({ ...base, key: 0, location: '3/1/0', caps: capabilitiesFor('1.9.0') })).not.toContain(
			'LOCATION'
		)
	})

	it('refuses to build without a key or control id', () => {
		expect(() => buildKeyState(base)).toThrow(/requires either key or controlId/)
	})
})

describe('other messages', () => {
	it('builds SUB-STATE without a device id', () => {
		expect(buildSubState({ subId: 'my/sub', values, preset: {}, caps: latest })).toBe(
			'SUB-STATE SUBID="my/sub" PRESSED=1 TYPE="BUTTON" \n'
		)
	})

	it('builds KEYS-CLEAR and BRIGHTNESS', () => {
		expect(buildKeysClear('dev1')).toBe('KEYS-CLEAR DEVICEID="dev1" \n')
		expect(buildBrightness('dev1', 100)).toBe('BRIGHTNESS DEVICEID="dev1" VALUE=100 \n')
	})

	it('base64s VARIABLE-VALUE and DEVICE-CONFIG payloads', () => {
		expect(buildVariableValue('dev1', 'my-var', 'hello')).toBe(
			'VARIABLE-VALUE DEVICEID="dev1" VARIABLE="my-var" VALUE="aGVsbG8=" \n'
		)
		expect(buildDeviceConfig('dev1', { 'my-field': 'some-value' })).toBe(
			'DEVICE-CONFIG DEVICEID="dev1" CONFIG="eyJteS1maWVsZCI6InNvbWUtdmFsdWUifQ==" \n'
		)
	})

	it('includes ROTATION on LOCKED-STATE from 1.10.1 only', () => {
		const opts = { deviceId: 'dev1', locked: true, characterCount: 2 }
		expect(buildLockedState({ ...opts, rotation: 90, caps: latest })).toBe(
			'LOCKED-STATE DEVICEID="dev1" LOCKED=1 CHARACTER_COUNT=2 ROTATION=90 \n'
		)
		expect(buildLockedState({ ...opts, caps: capabilitiesFor('1.10.0') })).toBe(
			'LOCKED-STATE DEVICEID="dev1" LOCKED=1 CHARACTER_COUNT=2 \n'
		)
	})

	it('echoes a PING payload raw', () => {
		expect(buildPong('some "arbitrary" payload')).toBe('PONG some "arbitrary" payload \n')
	})

	it('omits DEVICEID from responses before 1.2', () => {
		expect(buildOk('ADD-DEVICE', 'dev1', capabilitiesFor('1.1.0'))).toBe('ADD-DEVICE OK \n')
		expect(buildOk('ADD-DEVICE', 'dev1', latest)).toBe('ADD-DEVICE OK DEVICEID="dev1" \n')
		expect(buildErrorResponse('KEY-PRESS', 'dev1', ERRORS.deviceNotFound, capabilitiesFor('1.1.0'))).toBe(
			'KEY-PRESS ERROR MESSAGE="Device not found" \n'
		)
	})
})

describe('decodeBase64', () => {
	it('round trips', () => {
		expect(decodeBase64('aGVsbG8=', 1024)).toBe('hello')
	})

	it('refuses an oversized payload before allocating', () => {
		const huge = 'A'.repeat(4096)
		expect(decodeBase64(huge, 16)).toBeUndefined()
	})

	it('accepts a payload right at the limit', () => {
		expect(decodeBase64(Buffer.from('12345678').toString('base64'), 8)).toBe('12345678')
	})

	it('estimates the decoded length exactly, for every padding case', () => {
		// The first version of this ignored padding and over-estimated by up to two bytes, which
		// rejected payloads sitting exactly on the limit. Checking every length covers all three
		// padding cases without having to reason about which is which.
		for (let length = 0; length < 256; length++) {
			const encoded = Buffer.from('x'.repeat(length)).toString('base64')
			expect(decodedBase64Length(encoded), `length ${length}`).toBe(length)
			expect(decodeBase64(encoded, length)).toHaveLength(length)
			if (length > 0) expect(decodeBase64(encoded, length - 1)).toBeUndefined()
		}
	})
})
