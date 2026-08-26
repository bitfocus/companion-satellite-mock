import { describe, expect, it } from 'vitest'
import { hashIp, ipFields, truncate } from './logging.js'

describe('hashIp', () => {
	it('is stable within a run, so two connections can be correlated', () => {
		expect(hashIp('198.51.100.7')).toBe(hashIp('198.51.100.7'))
	})

	it('separates different addresses', () => {
		expect(hashIp('198.51.100.7')).not.toBe(hashIp('198.51.100.8'))
	})

	it('does not contain the address it came from', () => {
		expect(hashIp('198.51.100.7')).not.toContain('198.51.100.7')
	})
})

describe('ipFields', () => {
	it('includes the real address when the operator asked for it', () => {
		const fields = ipFields('198.51.100.7', true)

		// The whole point: the hash re-salts on restart, so it cannot answer questions about last
		// week. Abuse forensics needs the address itself.
		expect(fields.clientIp).toBe('198.51.100.7')
		expect(fields.ip).toBe(hashIp('198.51.100.7'))
	})

	it('omits it entirely when switched off — not blanked, absent', () => {
		const fields = ipFields('198.51.100.7', false)

		expect(fields.clientIp).toBeUndefined()
		expect('clientIp' in fields).toBe(false)
		// The correlating hash survives either way.
		expect(fields.ip).toBe(hashIp('198.51.100.7'))
	})

	it('never puts the raw address in the hashed field', () => {
		expect(ipFields('198.51.100.7', true).ip).not.toContain('198.51.100.7')
	})
})

describe('truncate', () => {
	it('leaves a short value alone', () => {
		expect(truncate('KEYS-CLEAR')).toBe('KEYS-CLEAR')
	})

	it('caps a long one and says how long it really was', () => {
		const result = truncate('x'.repeat(5000))

		expect(result.length).toBeLessThan(250)
		expect(result).toContain('5000 bytes')
	})
})
