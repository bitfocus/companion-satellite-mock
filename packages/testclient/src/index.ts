import { EventEmitter } from 'node:events'
import {
	normaliseLine,
	parseLineParameters,
	serialiseMessage,
	splitCommand,
	type ParsedParams,
} from '@satellite-mock/protocol'
import { WebSocket } from 'ws'

/**
 * A headless satellite client.
 *
 * Deliberately shares nothing with the server but `@satellite-mock/protocol`, so a bug in the
 * server's framing or dispatch cannot mask itself by being symmetrical. It is used by the
 * integration tests and is handy as a manual probe against a running instance.
 *
 * It is a *test* client, not a reference implementation: it does the minimum a real client does
 * (buffer, split on newline, ping, answer pings) and records everything for assertions.
 */

export interface ReceivedMessage {
	at: number
	line: string
	command: string
	params: ParsedParams
}

export interface TestClientOptions {
	url: string
	/** Real clients ping at 10Hz; 0 disables, for testing idle timeouts. */
	pingIntervalMs?: number
}

export interface TestClientEvents {
	message: [ReceivedMessage]
	open: []
	close: []
	error: [Error]
}

export class TestSatelliteClient extends EventEmitter<TestClientEvents> {
	readonly received: ReceivedMessage[] = []

	#socket: WebSocket | undefined
	#buffer = ''
	#ping: NodeJS.Timeout | undefined
	readonly #options: TestClientOptions

	constructor(options: TestClientOptions) {
		super()
		this.#options = options
	}

	async connect(): Promise<void> {
		const socket = new WebSocket(this.#options.url)
		this.#socket = socket

		socket.on('message', (data) => this.#onData(data.toString()))
		socket.on('error', (error) => this.emit('error', error))
		socket.on('close', () => {
			if (this.#ping) clearInterval(this.#ping)
			this.emit('close')
		})

		await new Promise<void>((resolve, reject) => {
			socket.once('open', () => resolve())
			socket.once('error', reject)
		})

		const interval = this.#options.pingIntervalMs ?? 100
		if (interval > 0) {
			this.#ping = setInterval(() => this.send('PING'), interval)
			this.#ping.unref()
		}

		this.emit('open')
	}

	/**
	 * Append to a buffer and split on newline — never assume one frame is one message.
	 *
	 * This is the behaviour the server's framing chaos tool exists to test, so the test client has to
	 * get it right or the tool would look like it was finding server bugs.
	 */
	#onData(chunk: string): void {
		this.#buffer += chunk

		let index: number
		while ((index = this.#buffer.indexOf('\n')) !== -1) {
			const line = normaliseLine(this.#buffer.slice(0, index))
			this.#buffer = this.#buffer.slice(index + 1)
			if (line.length === 0) continue

			const { command, body } = splitCommand(line)
			const upper = command.toUpperCase()

			// Answer server pings, or it will drop us.
			if (upper === 'PING') {
				this.send(`PONG ${body}`)
				continue
			}

			const message: ReceivedMessage = { at: Date.now(), line, command: upper, params: parseLineParameters(body) }
			this.received.push(message)
			this.emit('message', message)
		}
	}

	send(line: string): void {
		this.#socket?.send(line.endsWith('\n') ? line : `${line}\n`)
	}

	sendMessage(name: string, args: Record<string, string | number | boolean> = {}): void {
		this.send(serialiseMessage(name, null, null, args))
	}

	/** Register a surface and resolve once the server accepts or rejects it. */
	async addDevice(deviceId: string, args: Record<string, string | number | boolean> = {}): Promise<ReceivedMessage> {
		this.send(
			serialiseMessage('ADD-DEVICE', null, null, { DEVICEID: deviceId, PRODUCT_NAME: 'Test Client', ...args })
		)
		return this.waitFor('ADD-DEVICE')
	}

	/** Wait for the next message with this command, or one already received. */
	async waitFor(command: string, timeoutMs = 2000): Promise<ReceivedMessage> {
		const existing = this.received.find((m) => m.command === command)
		if (existing) return existing

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.off('message', onMessage)
				reject(new Error(`timed out waiting for ${command}`))
			}, timeoutMs)

			const onMessage = (message: ReceivedMessage) => {
				if (message.command !== command) return
				clearTimeout(timer)
				this.off('message', onMessage)
				resolve(message)
			}
			this.on('message', onMessage)
		})
	}

	/** Wait until `count` messages with this command have been received in total. */
	async waitForCount(command: string, count: number, timeoutMs = 2000): Promise<ReceivedMessage[]> {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			const matching = this.received.filter((m) => m.command === command)
			if (matching.length >= count) return matching
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for ${count}x ${command}, saw ${matching.length}`)
			}
			await new Promise((resolve) => setTimeout(resolve, 5))
		}
	}

	messagesOf(command: string): ReceivedMessage[] {
		return this.received.filter((m) => m.command === command)
	}

	clearReceived(): void {
		this.received.length = 0
	}

	close(): void {
		if (this.#ping) clearInterval(this.#ping)
		this.#socket?.close()
	}
}
