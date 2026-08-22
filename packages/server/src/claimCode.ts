import { randomInt, timingSafeEqual } from 'node:crypto'

/**
 * Crockford base32, minus the letters that get misread aloud or on a low-resolution button.
 *
 * The code is drawn onto the surface itself and then typed into a web page by a human reading it off
 * a screen, so the alphabet matters more than the entropy: I/1, O/0 and U/V are the classic
 * misreads. 30 symbols over 6 characters is ~7.3e8 combinations, which brute force cannot reach
 * through the attempt limiter.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.replace(/[ILOU]/g, '')
const CODE_LENGTH = 6

export function generateClaimCode(): string {
	let code = ''
	// randomInt, not Math.random: the code is the only thing standing between a stranger and someone
	// else's session, and a predictable PRNG would make the length pointless.
	for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
	return code
}

/** Format for display: `K7M-2QP`. The hyphen is cosmetic and ignored on input. */
export function formatClaimCode(code: string): string {
	return `${code.slice(0, 3)}-${code.slice(3)}`
}

/**
 * Normalise user input: strip separators and whitespace, uppercase, and fold the characters people
 * reliably mistype. Someone reading `0` as `O` should not be locked out of their own session.
 */
export function normaliseClaimCode(input: string): string {
	return input
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/O/g, '0')
		.replace(/I/g, '1')
		.replace(/L/g, '1')
		.replace(/U/g, 'V')
}

/** Constant-time comparison, so response timing cannot be used to narrow the code. */
export function claimCodeMatches(input: string, actual: string): boolean {
	const a = Buffer.from(normaliseClaimCode(input))
	const b = Buffer.from(actual)
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}
