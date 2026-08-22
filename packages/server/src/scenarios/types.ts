import type { Device } from '../devices.js'
import type { SurfaceEmitter } from '../emitter.js'
import type { ButtonStyle } from '../render/buttonStyle.js'

/** Capabilities a scenario may need. It still runs without them, just showing less. */
export type ScenarioFeature = 'bitmaps' | 'colors' | 'text' | 'leds' | 'variables' | 'pincode' | 'configFields'

export interface ScenarioContext {
	readonly device: Device
	readonly emitter: SurfaceEmitter
	/** Control ids in reading order, so a scenario can lay content out without knowing the mode. */
	readonly controlIds: readonly string[]
	readonly gridSize: { rows: number; columns: number }
	/** Which of the features this scenario wanted the client actually negotiated. */
	readonly available: ReadonlySet<ScenarioFeature>
	/** Scenario-local state, so a scenario needs no instance of its own. */
	readonly state: Map<string, unknown>
	readonly params: Record<string, unknown>

	draw(controlId: string, style: Partial<ButtonStyle>): void
	drawAll(style: Partial<ButtonStyle>): void
	clear(): void
	setBrightness(value: number): void
	setLocked(locked: boolean, characterCount: number): void
	sendVariable(id: string, value: string): void
	sendDeviceConfig(values: Record<string, unknown>): void
	log(message: string): void
}

export interface Scenario {
	readonly id: string
	readonly name: string
	readonly description: string
	/** Declared so the UI can grey out what the connected client cannot show. */
	readonly wants?: readonly ScenarioFeature[]
	/** Milliseconds between ticks. Omit for a scenario that only reacts to input. */
	readonly tickMs?: number

	init(context: ScenarioContext): void
	onPress?(context: ScenarioContext, controlId: string, pressed: boolean): void
	onRotate?(context: ScenarioContext, controlId: string, delta: number): void
	onPincodeKey?(context: ScenarioContext, digit: number): void
	onVariable?(context: ScenarioContext, id: string, value: string): void
	onChangePage?(context: ScenarioContext, forward: boolean): void
	tick?(context: ScenarioContext, elapsedMs: number): void
	dispose?(context: ScenarioContext): void
}

/** Work out what the client can actually display, from what it asked for in ADD-DEVICE. */
export function availableFeatures(device: Device): Set<ScenarioFeature> {
	const features = new Set<ScenarioFeature>()

	for (const control of device.surface.controls.values()) {
		if (control.style.bitmap) features.add('bitmaps')
		if (control.style.colors) features.add('colors')
		if (control.style.text) features.add('text')
		if (control.style.leds) features.add('leds')
	}

	if (device.variables.length > 0) features.add('variables')
	if (device.supportsLockedState) features.add('pincode')
	if (device.configFields) features.add('configFields')

	return features
}
