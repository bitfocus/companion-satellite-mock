import { describe, expect, it } from 'vitest'
import { LineBuffer } from './lineBuffer.js'

describe('LineBuffer', () => {
	it('emits a complete line', () => {
		expect(new LineBuffer(1024).push('PING\n').lines).toEqual(['PING'])
	})

	it('emits several lines from one chunk', () => {
		expect(new LineBuffer(1024).push('A\nB\nC\n').lines).toEqual(['A', 'B', 'C'])
	})

	it('holds an incomplete line until its terminator arrives', () => {
		const buffer = new LineBuffer(1024)
		expect(buffer.push('PI').lines).toEqual([])
		expect(buffer.push('NG').lines).toEqual([])
		expect(buffer.push('\n').lines).toEqual(['PING'])
	})

	it('reassembles a line delivered one byte at a time', () => {
		// The framing case that breaks clients assuming one frame is one message — and the reason
		// the chaos tool can deliberately split frames this way.
		const buffer = new LineBuffer(1024)
		const line = 'KEY-STATE DEVICEID="dev1" KEY=0 '
		const out: string[] = []
		for (const char of `${line}\n`) out.push(...buffer.push(char).lines)
		expect(out).toEqual([line])
	})

	it('handles many lines coalesced into a single chunk', () => {
		const buffer = new LineBuffer(1024)
		const chunk = Array.from({ length: 50 }, (_, i) => `X A=${i}`).join('\n') + '\n'
		expect(buffer.push(chunk).lines).toHaveLength(50)
	})

	it('preserves an empty line rather than dropping it', () => {
		expect(new LineBuffer(1024).push('A\n\nB\n').lines).toEqual(['A', '', 'B'])
	})

	it("leaves \\r on the line, because stripping it is the parser's job", () => {
		expect(new LineBuffer(1024).push('A=1\r\n').lines).toEqual(['A=1\r'])
	})

	it('reports overflow when a line exceeds the limit with no terminator', () => {
		const buffer = new LineBuffer(16)
		const result = buffer.push('x'.repeat(20))
		expect(result.overflow).toBe(true)
		expect(result.lines).toEqual([])
	})

	it('clears the buffer on overflow so the next chunk is not appended to garbage', () => {
		const buffer = new LineBuffer(16)
		buffer.push('x'.repeat(20))
		expect(buffer.pending).toBe(0)
	})

	it('does not overflow on a long stream that is split into short lines', () => {
		const buffer = new LineBuffer(16)
		for (let i = 0; i < 100; i++) {
			expect(buffer.push('abc\n').overflow).toBe(false)
		}
	})

	it('still yields the complete lines that arrived alongside an overflow', () => {
		const buffer = new LineBuffer(16)
		const result = buffer.push('GOOD\n' + 'x'.repeat(20))
		expect(result.lines).toEqual(['GOOD'])
		expect(result.overflow).toBe(true)
	})
})
