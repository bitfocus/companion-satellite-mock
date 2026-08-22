import type { Device } from '../devices.js'
import type { SurfaceEmitter } from '../emitter.js'
import type { Logger } from '../logging.js'
import type { ButtonStyle } from '../render/buttonStyle.js'
import { availableFeatures, type Scenario, type ScenarioContext, type ScenarioFeature } from './types.js'

export interface RunningScenario {
	readonly scenario: Scenario
	readonly context: ScenarioContext
	lastTickAt: number
}

/**
 * Runs scenarios against devices.
 *
 * All ticking is driven from a *single* shared interval rather than one timer per scenario: with a
 * few hundred sessions, per-scenario timers are hundreds of wakeups a second doing nothing. Each
 * scenario declares its own `tickMs` and the engine calls it when due.
 */
export class ScenarioEngine {
	readonly #running = new Map<string, RunningScenario>()
	readonly #logger: Logger
	readonly #now: () => number
	#timer: NodeJS.Timeout | undefined

	/** How often the shared timer wakes. The floor on any scenario's effective tick rate. */
	static readonly TICK_RESOLUTION_MS = 50

	constructor(logger: Logger, now: () => number = Date.now) {
		this.#logger = logger.child({ component: 'scenarios' })
		this.#now = now
	}

	get runningCount(): number {
		return this.#running.size
	}

	start(): void {
		if (this.#timer) return
		this.#timer = setInterval(() => this.tickAll(), ScenarioEngine.TICK_RESOLUTION_MS)
		this.#timer.unref()
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer)
		this.#timer = undefined
	}

	get(deviceId: string): RunningScenario | undefined {
		return this.#running.get(deviceId)
	}

	/** Attach a scenario to a device, replacing whatever was running. */
	attach(
		device: Device,
		emitter: SurfaceEmitter,
		scenario: Scenario,
		params: Record<string, unknown> = {}
	): RunningScenario {
		this.detach(device.id)

		const context = this.#buildContext(device, emitter, params)
		const running: RunningScenario = { scenario, context, lastTickAt: this.#now() }
		this.#running.set(device.id, running)

		// A scenario must never take the connection down. Anything it throws is contained and logged.
		this.#guard(running, 'init', () => scenario.init(context))

		return running
	}

	detach(deviceId: string): void {
		const running = this.#running.get(deviceId)
		if (!running) return
		this.#running.delete(deviceId)
		if (running.scenario.dispose) {
			this.#guard(running, 'dispose', () => running.scenario.dispose?.(running.context))
		}
	}

	tickAll(): void {
		const now = this.#now()
		for (const running of this.#running.values()) {
			const tickMs = running.scenario.tickMs
			if (!tickMs || !running.scenario.tick) continue

			const elapsed = now - running.lastTickAt
			if (elapsed < tickMs) continue

			running.lastTickAt = now
			this.#guard(running, 'tick', () => running.scenario.tick?.(running.context, elapsed))
		}
	}

	press(deviceId: string, controlId: string, pressed: boolean): void {
		const running = this.#running.get(deviceId)
		if (!running?.scenario.onPress) return
		this.#guard(running, 'onPress', () => running.scenario.onPress?.(running.context, controlId, pressed))
	}

	rotate(deviceId: string, controlId: string, delta: number): void {
		const running = this.#running.get(deviceId)
		if (!running?.scenario.onRotate) return
		this.#guard(running, 'onRotate', () => running.scenario.onRotate?.(running.context, controlId, delta))
	}

	pincodeKey(deviceId: string, digit: number): void {
		const running = this.#running.get(deviceId)
		if (!running?.scenario.onPincodeKey) return
		this.#guard(running, 'onPincodeKey', () => running.scenario.onPincodeKey?.(running.context, digit))
	}

	variable(deviceId: string, id: string, value: string): void {
		const running = this.#running.get(deviceId)
		if (!running?.scenario.onVariable) return
		this.#guard(running, 'onVariable', () => running.scenario.onVariable?.(running.context, id, value))
	}

	changePage(deviceId: string, forward: boolean): void {
		const running = this.#running.get(deviceId)
		if (!running?.scenario.onChangePage) return
		this.#guard(running, 'onChangePage', () => running.scenario.onChangePage?.(running.context, forward))
	}

	#guard(running: RunningScenario, phase: string, fn: () => void): void {
		try {
			fn()
		} catch (error) {
			this.#logger.error({ err: error, scenario: running.scenario.id, phase }, 'scenario threw')
		}
	}

	#buildContext(device: Device, emitter: SurfaceEmitter, params: Record<string, unknown>): ScenarioContext {
		const available = availableFeatures(device)
		const controlIds = [...device.surface.controls.values()]
			// Reading order, so a scenario can lay content out without knowing the registration mode.
			.sort((a, b) => a.row - b.row || a.column - b.column)
			.map((control) => control.id)

		const logger = this.#logger.child({ device: device.id })

		return {
			device,
			emitter,
			controlIds,
			gridSize: device.surface.gridSize,
			available: available as ReadonlySet<ScenarioFeature>,
			state: new Map<string, unknown>(),
			params,
			draw: (controlId: string, style: Partial<ButtonStyle>) => emitter.draw(controlId, style),
			drawAll: (style: Partial<ButtonStyle>) => emitter.drawAll(style),
			clear: () => emitter.clearKeys(),
			setBrightness: (value: number) => emitter.setBrightness(value),
			setLocked: (locked: boolean, characterCount: number) => emitter.setLocked(locked, characterCount),
			sendVariable: (id: string, value: string) => emitter.sendVariable(id, value),
			sendDeviceConfig: (values: Record<string, unknown>) => emitter.sendDeviceConfig(values),
			log: (message: string) => logger.debug(message),
		}
	}
}
