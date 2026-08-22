import {
	buildBrightness,
	buildDeviceConfig,
	buildKeyState,
	buildKeysClear,
	buildLockedState,
	buildSubState,
	buildVariableValue,
	convertXYToIndex,
	type SatelliteCapabilities,
} from '@satellite-mock/protocol'
import type { Device } from './devices.js'
import type { Subscription } from './events.js'
import type { RenderBudget } from './render/budget.js'
import { sampleLedsToBuffer } from './render/leds.js'
import type { ButtonRenderer } from './render/renderer.js'
import { type Rotation } from './render/renderer.js'
import { DEFAULT_BUTTON_STYLE, type ButtonStyle } from './render/buttonStyle.js'
import type { SatelliteConnection } from './transport/types.js'

export interface EmitterOptions {
	device: Device
	connection: SatelliteConnection
	capabilities: SatelliteCapabilities
	renderer: ButtonRenderer
	budget: RenderBudget
	/** Bytes allowed to sit unflushed on the socket before we give up on the client. */
	maxQueuedBytes?: number
	rotation?: Rotation
	onOverflow?: () => void
}

/**
 * Turns "this control should look like X" into wire messages.
 *
 * Two things make this more than a formatting layer:
 *
 * - **Latest-wins coalescing.** A control redrawn three times before the queue flushes is sent once,
 *   with the newest style. Companion does the same with its `ImageWriteQueue`, and without it a
 *   scenario running at 30fps on a slow link builds an unbounded backlog of frames nobody will ever
 *   see.
 * - **Backpressure.** If the socket cannot keep up, the queue is dropped and the connection closed
 *   rather than buffering without limit. A public server cannot let one slow client consume memory
 *   indefinitely.
 */
export class SurfaceEmitter {
	readonly #device: Device
	readonly #connection: SatelliteConnection
	readonly #capabilities: SatelliteCapabilities
	readonly #renderer: ButtonRenderer
	readonly #budget: RenderBudget
	readonly #maxQueuedBytes: number
	readonly #rotation: Rotation
	readonly #onOverflow: (() => void) | undefined

	/** Current style per control, so a partial update can be merged onto what is already shown. */
	readonly #styles = new Map<string, ButtonStyle>()
	/** Controls awaiting a flush. A Set, because the style itself lives in #styles — latest wins. */
	readonly #pending = new Set<string>()
	#flushScheduled = false
	#sent = 0
	#coalesced = 0

	constructor(options: EmitterOptions) {
		this.#device = options.device
		this.#connection = options.connection
		this.#capabilities = options.capabilities
		this.#renderer = options.renderer
		this.#budget = options.budget
		this.#maxQueuedBytes = options.maxQueuedBytes ?? 4 * 1024 * 1024
		this.#rotation = options.rotation ?? 0
		this.#onOverflow = options.onOverflow
	}

	get stats(): { sent: number; coalesced: number; pending: number } {
		return { sent: this.#sent, coalesced: this.#coalesced, pending: this.#pending.size }
	}

	styleOf(controlId: string): ButtonStyle {
		return this.#styles.get(controlId) ?? DEFAULT_BUTTON_STYLE
	}

	/** Queue a control for redraw, merging onto its current style. */
	draw(controlId: string, style: Partial<ButtonStyle>): void {
		if (!this.#device.surface.controls.has(controlId)) return

		const merged = { ...this.styleOf(controlId), ...style }
		this.#styles.set(controlId, merged)

		if (this.#pending.has(controlId)) this.#coalesced++
		this.#pending.add(controlId)
		this.#scheduleFlush()
	}

	drawAll(style: Partial<ButtonStyle>): void {
		for (const controlId of this.#device.surface.controls.keys()) this.draw(controlId, style)
	}

	/** Send everything queued now, rather than waiting for the microtask. */
	flush(): void {
		this.#flushScheduled = false
		if (this.#pending.size === 0) return

		if (this.#isOverflowing()) {
			this.#pending.clear()
			this.#onOverflow?.()
			return
		}

		const pending = [...this.#pending]
		this.#pending.clear()

		for (const controlId of pending) {
			const control = this.#device.surface.controls.get(controlId)
			if (!control) continue

			const style = this.styleOf(controlId)
			const args = this.#buildArgs(controlId, style)
			if (!args) continue

			this.#connection.send(
				buildKeyState({
					deviceId: this.#device.id,
					...(this.#device.surface.fromManifest
						? { controlId }
						: { key: convertXYToIndex(control.column, control.row, this.#device.surface.gridSize) ?? 0 }),
					values: args.values,
					preset: control.style,
					caps: this.#capabilities,
				})
			)
			this.#sent++
		}
	}

	#buildArgs(controlId: string, style: ButtonStyle) {
		const control = this.#device.surface.controls.get(controlId)
		if (!control) return undefined

		const preset = control.style
		const values: Parameters<typeof buildKeyState>[0]['values'] = {
			pressed: style.pressed,
			type: style.type,
		}

		if (preset.bitmap) {
			// Over budget: skip the bitmap rather than the whole message, so colour and text still
			// update and the surface stays responsive under load.
			if (this.#budget.tryConsume(preset.bitmap.w, preset.bitmap.h)) {
				values.bitmap = this.#renderer.render(style, {
					width: preset.bitmap.w,
					height: preset.bitmap.h,
					format: this.#device.bitmapFormat,
					rotation: this.#rotation,
				})
			}
		}

		if (preset.colors) {
			values.color = formatColor(style.bgColor, preset.colors)
			values.textColor = formatColor(style.textColor, preset.colors)
		}
		if (preset.text) values.text = style.text
		if (preset.textStyle) values.fontSize = style.fontSize
		if (preset.leds && style.gauge !== undefined) {
			values.leds = sampleLedsToBuffer(style.gauge, preset.leds.segments, preset.leds.mode).toString('base64')
		}

		return { values }
	}

	#scheduleFlush(): void {
		if (this.#flushScheduled) return
		this.#flushScheduled = true
		// A microtask, so a scenario touching twenty controls in one tick produces one flush.
		queueMicrotask(() => this.flush())
	}

	#isOverflowing(): boolean {
		const buffered = (this.#connection as { bufferedAmount?: number }).bufferedAmount
		return typeof buffered === 'number' && buffered > this.#maxQueuedBytes
	}

	clearKeys(): void {
		this.#pending.clear()
		this.#styles.clear()
		this.#connection.send(buildKeysClear(this.#device.id))
	}

	setBrightness(value: number): void {
		// A device that opted out gets no brightness messages at all, per the 1.7 opt-out.
		if (!this.#device.supportsBrightness) return
		this.#connection.send(buildBrightness(this.#device.id, Math.max(0, Math.min(100, Math.round(value)))))
	}

	setLocked(locked: boolean, characterCount: number, rotation: 0 | 90 | -90 | 180 = 0): void {
		if (!this.#device.supportsLockedState) return
		this.#connection.send(
			buildLockedState({
				deviceId: this.#device.id,
				locked,
				characterCount,
				rotation,
				caps: this.#capabilities,
			})
		)
	}

	sendVariable(variable: string, value: string): void {
		// Only variables the client declared as outputs are streamed to it.
		const declared = this.#device.variables.find((v) => v.id === variable && v.type === 'output')
		if (!declared) return
		this.#connection.send(buildVariableValue(this.#device.id, variable, value))
	}

	sendDeviceConfig(config: Record<string, unknown>): void {
		if (!this.#device.configFields) return
		this.#connection.send(buildDeviceConfig(this.#device.id, config))
	}
}

/** Send a subscription's state. Subscriptions are connection-scoped, so they bypass the emitter. */
export function sendSubState(
	connection: SatelliteConnection,
	subscription: Subscription,
	style: ButtonStyle,
	renderer: ButtonRenderer,
	budget: RenderBudget,
	capabilities: SatelliteCapabilities
): void {
	const preset = subscription.style
	const values: Parameters<typeof buildSubState>[0]['values'] = {
		pressed: style.pressed,
		type: style.type,
	}

	if (preset.bitmap && budget.tryConsume(preset.bitmap.w, preset.bitmap.h)) {
		values.bitmap = renderer.render(style, {
			width: preset.bitmap.w,
			height: preset.bitmap.h,
			format: subscription.bitmapFormat,
		})
	}
	if (preset.colors) {
		values.color = formatColor(style.bgColor, preset.colors)
		values.textColor = formatColor(style.textColor, preset.colors)
	}
	if (preset.text) values.text = style.text
	if (preset.textStyle) values.fontSize = style.fontSize

	connection.send(buildSubState({ subId: subscription.subId, values, preset, caps: capabilities }))
}

/**
 * Render a colour in the format the client negotiated.
 *
 * Input is always `#rrggbb` internally; `rgb` output has no spaces, matching Companion.
 */
export function formatColor(color: string, format: 'hex' | 'rgb'): string {
	if (format === 'hex') return color
	const hex = color.replace('#', '')
	const value = parseInt(hex, 16)

	return `rgb(${(value >> 16) & 0xff},${(value >> 8) & 0xff},${value & 0xff})`
}
