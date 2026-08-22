import { describe, expect, it } from 'vitest'
import { claimCodeMatches, formatClaimCode, generateClaimCode, normaliseClaimCode } from './claimCode.js'

describe('generateClaimCode', () => {
	it('is six characters from the unambiguous alphabet', () => {
		for (let i = 0; i < 200; i++) {
			const code = generateClaimCode()
			expect(code).toHaveLength(6)
			// I, L, O and U are excluded: the code is read off a button and typed into a browser, so
			// the characters people misread matter more than the extra bit of entropy.
			expect(code).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{6}$/)
			expect(code).not.toMatch(/[ILOU]/)
		}
	})

	it('does not obviously repeat', () => {
		const codes = new Set(Array.from({ length: 500 }, generateClaimCode))
		expect(codes.size).toBeGreaterThan(495)
	})
})

describe('normaliseClaimCode', () => {
	it('strips the display separator and whitespace', () => {
		expect(normaliseClaimCode('K7M-2QP')).toBe('K7M2QP')
		expect(normaliseClaimCode(' k7m 2qp ')).toBe('K7M2QP')
	})

	it('folds the characters people reliably mistype', () => {
		// Someone reading 0 as O should not be locked out of their own session.
		expect(normaliseClaimCode('O1L')).toBe('011')
		expect(normaliseClaimCode('U')).toBe('V')
	})
})

describe('claimCodeMatches', () => {
	it('accepts the code in any of the forms a human might type it', () => {
		expect(claimCodeMatches('K7M2QP', 'K7M2QP')).toBe(true)
		expect(claimCodeMatches('k7m-2qp', 'K7M2QP')).toBe(true)
		expect(claimCodeMatches(' K7M 2QP ', 'K7M2QP')).toBe(true)
	})

	it('rejects a different code, and a prefix', () => {
		expect(claimCodeMatches('K7M2QQ', 'K7M2QP')).toBe(false)
		expect(claimCodeMatches('K7M2Q', 'K7M2QP')).toBe(false)
		expect(claimCodeMatches('', 'K7M2QP')).toBe(false)
	})

	it('does not throw on a wildly wrong length', () => {
		// timingSafeEqual throws on mismatched lengths, so the guard has to come first.
		expect(claimCodeMatches('x'.repeat(1000), 'K7M2QP')).toBe(false)
	})

	it('formats for display without changing what matches', () => {
		const code = generateClaimCode()
		expect(formatClaimCode(code)).toMatch(/^.{3}-.{3}$/)
		expect(claimCodeMatches(formatClaimCode(code), code)).toBe(true)
	})
})
