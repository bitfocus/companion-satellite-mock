import { describe, expect, it } from 'vitest'
import { SUPPORTED_API_VERSION } from './index.js'

describe('protocol package', () => {
	it('targets the API version documented in docs/protocol.md', () => {
		expect(SUPPORTED_API_VERSION).toBe('1.14.0')
	})
})
