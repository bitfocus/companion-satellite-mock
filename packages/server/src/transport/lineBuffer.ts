/**
 * Accumulates inbound bytes and emits complete lines.
 *
 * This is the piece that makes the WebSocket transport behave like the TCP one: Companion appends
 * every received frame's text into a buffer and splits on `\n`, so one frame is emphatically not one
 * message. Getting this wrong is the single most common satellite client bug, which is why the mock
 * can deliberately split and coalesce frames later.
 */
export class LineBuffer {
	#buffer = ''

	constructor(private readonly maxLineBytes: number) {}

	/**
	 * Feed a chunk, returning any complete lines it produced.
	 *
	 * `overflow` means the buffer exceeded the line limit without a terminator — the caller must
	 * report `Line too long` and destroy the connection. It is deliberately a return value rather
	 * than a thrown error: an oversized line is expected traffic on a public server, not an
	 * exceptional condition.
	 */
	push(chunk: string): { lines: string[]; overflow: boolean } {
		this.#buffer += chunk

		const lines: string[] = []
		let offset = 0
		let index: number
		while ((index = this.#buffer.indexOf('\n', offset)) !== -1) {
			lines.push(this.#buffer.slice(offset, index))
			offset = index + 1
		}
		this.#buffer = this.#buffer.slice(offset)

		// Guard against a client that streams forever without ever sending a terminator.
		if (this.#buffer.length > this.maxLineBytes) {
			this.#buffer = ''
			return { lines, overflow: true }
		}

		return { lines, overflow: false }
	}

	get pending(): number {
		return this.#buffer.length
	}

	reset(): void {
		this.#buffer = ''
	}
}
