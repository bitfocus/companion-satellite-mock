import type { Config } from './config.js'
import type { Device } from './devices.js'
import { SurfaceEmitter } from './emitter.js'
import type { SatelliteEvents } from './events.js'
import type { Logger } from './logging.js'
import { RenderBudget } from './render/budget.js'
import { ButtonRenderer } from './render/renderer.js'
import { ScenarioEngine } from './scenarios/engine.js'
import { findScenario, unclaimedScenario } from './scenarios/builtin.js'
import type { Scenario } from './scenarios/types.js'
import type { SatelliteSession } from './satelliteSession.js'
import { SessionManager, type MockSession } from './sessions.js'

export interface RuntimeOptions {
	config: Config
	logger: Logger
	publicUrl?: string
	renderer?: ButtonRenderer
}

interface DeviceRuntime {
	device: Device
	emitter: SurfaceEmitter
	session: MockSession
	budget: RenderBudget
}

/**
 * Ties the protocol layer to sessions, rendering and scenarios.
 *
 * This is the piece that makes the mock *do* something: a device that registers is immediately given
 * a session, an emitter and the Unclaimed scenario, so a client that connects sees a live surface
 * without anyone touching the web UI. That is the zero-interaction path, and it is the default
 * rather than a mode that has to be switched on.
 */
export class MockRuntime {
	readonly sessions: SessionManager
	readonly scenarios: ScenarioEngine
	readonly renderer: ButtonRenderer

	readonly #config: Config
	readonly #logger: Logger
	readonly #publicUrl: string
	readonly #devices = new Map<string, DeviceRuntime>()
	#sweep: NodeJS.Timeout | undefined

	constructor(options: RuntimeOptions) {
		this.#config = options.config
		this.#logger = options.logger.child({ component: 'runtime' })
		this.#publicUrl = options.publicUrl ?? options.config.PUBLIC_ORIGIN ?? 'this server'
		this.renderer = options.renderer ?? new ButtonRenderer()

		this.sessions = new SessionManager({
			graceMs: options.config.SESSION_GRACE_MS,
			maxLifetimeMs: options.config.MAX_CONNECTION_LIFETIME_MS,
		})
		this.scenarios = new ScenarioEngine(this.#logger)
	}

	start(): void {
		this.scenarios.start()
		this.#sweep = setInterval(() => this.sessions.sweep(), 30_000)
		this.#sweep.unref()
	}

	stop(): void {
		this.scenarios.stop()
		if (this.#sweep) clearInterval(this.#sweep)
		this.#sweep = undefined
	}

	runtimeFor(deviceId: string): DeviceRuntime | undefined {
		return this.#devices.get(deviceId)
	}

	/** Switch a device to a different scenario, by id. Returns false for an unknown one. */
	selectScenario(deviceId: string, scenarioId: string, params: Record<string, unknown> = {}): boolean {
		const runtime = this.#devices.get(deviceId)
		if (!runtime) return false

		const scenario = scenarioId === 'unclaimed' ? this.#unclaimedFor(runtime.session) : findScenario(scenarioId)
		if (!scenario) return false

		runtime.emitter.clearKeys()
		this.scenarios.attach(runtime.device, runtime.emitter, scenario, params)
		return true
	}

	#unclaimedFor(session: MockSession): Scenario {
		return unclaimedScenario(session.claimCode, this.#publicUrl)
	}

	/** The event handlers to hand to the SatelliteServer. */
	events(): SatelliteEvents {
		return {
			onDeviceAdded: (connection, device) => this.#onDeviceAdded(connection, device),
			onDeviceRemoved: (_connection, device) => this.#onDeviceRemoved(device),
			onKeyPress: (_c, device, controlId, pressed) => this.scenarios.press(device.id, controlId, pressed),
			onKeyRotate: (_c, device, controlId, delta) => this.scenarios.rotate(device.id, controlId, delta),
			onPincodeKey: (_c, device, digit) => this.scenarios.pincodeKey(device.id, digit),
			onVariableValue: (_c, device, id, value) => this.scenarios.variable(device.id, id, value),
			onChangePage: (_c, device, forward) => this.scenarios.changePage(device.id, forward),
			onFirmwareUpdateInfo: (_c, device, url) => {
				// Recorded for the web UI only. Never fetched — see docs/design.md §9.1.
				this.#logger.info({ device: device.id, hasUrl: url !== null }, 'firmware update info reported')
			},
		}
	}

	#onDeviceAdded(connection: SatelliteSession, device: Device): void {
		const session = this.sessions.attach(connection, device.id)
		this.sessions.noteDevice(session, device)

		const budget = new RenderBudget(this.#config.MAX_BYTES_PER_SECOND * 4)
		const emitter = new SurfaceEmitter({
			device,
			connection: connection.connection,
			capabilities: connection.capabilities,
			renderer: this.renderer,
			budget,
			onOverflow: () => {
				this.#logger.warn({ device: device.id }, 'send queue overflowed, closing connection')
				connection.close()
			},
		})

		this.#devices.set(device.id, { device, emitter, session, budget })

		// Attach immediately, so a client that connects sees a live surface with no web UI involved.
		// An already-claimed session keeps whatever it was running before the reconnect.
		const previous = session.claimedBy ? this.scenarios.get(device.id)?.scenario : undefined
		this.scenarios.attach(device, emitter, previous ?? this.#unclaimedFor(session))

		this.#logger.info({ device: device.id, claimCode: session.claimCode }, 'device attached')
	}

	#onDeviceRemoved(device: Device): void {
		this.scenarios.detach(device.id)
		const runtime = this.#devices.get(device.id)
		this.#devices.delete(device.id)
		if (runtime) this.sessions.detach(runtime.session)
	}
}
