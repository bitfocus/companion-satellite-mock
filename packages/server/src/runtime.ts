import { coerceConfigValue, defaultConfigValues, type ConfigValue } from '@satellite-mock/protocol'
import type { Config } from './config.js'
import type { Device } from './devices.js'
import { SurfaceEmitter } from './emitter.js'
import type { SatelliteEvents } from './events.js'
import type { Logger } from './logging.js'
import { RenderBudget } from './render/budget.js'
import { ButtonRenderer } from './render/renderer.js'
import { ScenarioEngine } from './scenarios/engine.js'
import { findScenario, unclaimedScenario } from './scenarios/builtin.js'
import { drawUnpairable } from './scenarios/unpairable.js'
import type { Scenario } from './scenarios/types.js'
import type { SatelliteSession } from './satelliteSession.js'
import { SessionManager, type MockSession } from './sessions.js'
import { locationKey, SubscriptionPages } from './subscriptions.js'
import type { ButtonStyle } from './render/buttonStyle.js'

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
	/** Current values for the client's declared CONFIG_FIELDS, as Companion's surface settings hold. */
	configValues: Record<string, ConfigValue>
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
	readonly pages: SubscriptionPages

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
		// Shared budget: subscriptions render on the same thread as everything else, so they draw
		// from one ceiling rather than each having their own.
		this.#subscriptionBudget = new RenderBudget(options.config.MAX_BYTES_PER_SECOND * 4)
		this.pages = new SubscriptionPages(this.renderer, this.#subscriptionBudget)
	}

	readonly #subscriptionBudget: RenderBudget

	/**
	 * Every live connection, tracked directly rather than derived from devices or UI sessions.
	 *
	 * A connection may hold subscriptions without ever registering a device, so neither of those is
	 * a complete list — deriving it from them silently broadcast to nobody.
	 */
	readonly #connections = new Set<SatelliteSession>()

	/** Set a virtual page location's content and push it to every subscription watching it. */
	setPageContent(location: string, style: Partial<ButtonStyle>): number {
		return this.pages.set(location, style, this.#connections)
	}

	get connectionCount(): number {
		return this.#connections.size
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

	/** Current config values for a device, for the UI to render. */
	configValuesFor(deviceId: string): Record<string, ConfigValue> {
		return this.#devices.get(deviceId)?.configValues ?? {}
	}

	/**
	 * Apply an operator's config change and push it to the client.
	 *
	 * Values are coerced against the field the client declared and anything that does not fit is
	 * rejected: the web UI is public and unauthenticated, so this is untrusted input like any other,
	 * and a client that declared a `number` field should never receive a string.
	 */
	setConfigValue(deviceId: string, fieldId: string, value: unknown): boolean {
		const runtime = this.#devices.get(deviceId)
		if (!runtime?.device.configFields) return false

		const field = runtime.device.configFields.find((candidate) => candidate.id === fieldId)
		if (!field) return false

		const coerced = coerceConfigValue(field, value)
		if (coerced === undefined) return false

		runtime.configValues[fieldId] = coerced
		runtime.emitter.sendDeviceConfig(runtime.configValues)
		return true
	}

	/** The event handlers to hand to the SatelliteServer. */
	events(): SatelliteEvents {
		return {
			onConnectionOpen: (session) => this.#connections.add(session),
			onConnectionClose: (session) => this.#connections.delete(session),
			onDeviceAdded: (connection, device) => this.#onDeviceAdded(connection, device),
			onDeviceRejected: (connection, device) => this.#onDeviceRejected(connection, device),
			onDeviceRemoved: (_connection, device) => this.#onDeviceRemoved(device),
			onKeyPress: (_c, device, controlId, pressed) => this.scenarios.press(device.id, controlId, pressed),
			onKeyRotate: (_c, device, controlId, delta) => this.scenarios.rotate(device.id, controlId, delta),
			onPincodeKey: (_c, device, digit) => this.scenarios.pincodeKey(device.id, digit),
			onVariableValue: (_c, device, id, value) => this.scenarios.variable(device.id, id, value),
			onChangePage: (_c, device, forward) => this.scenarios.changePage(device.id, forward),
			// The command handler sends the one initial SUB-STATE; it asks here what the location
			// currently shows. Having a second layer follow up with the real content produced a blank
			// state and then a real one, and only worked when that layer happened to be wired up.
			resolveSubscriptionContent: (subscription) => this.pages.get(locationKey(subscription)),
			onFirmwareUpdateInfo: (_c, device, url) => {
				// Recorded for the web UI only. Never fetched — see docs/design.md §9.1.
				this.#logger.info({ device: device.id, hasUrl: url !== null }, 'firmware update info reported')
			},
		}
	}

	#onDeviceAdded(connection: SatelliteSession, device: Device): void {
		const session = this.sessions.attach(connection, device.id)
		this.sessions.noteDevice(session, device)

		const budget = new RenderBudget(this.#config.MAX_BYTES_PER_SECOND * 4, surfacePixels(device))
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
			// Without this the trace shows the handshake and input but never a single KEY-STATE,
			// which is most of what a client author wants to see.
			trace: (line) => session.record('out', line),
		})

		const configValues = device.configFields ? defaultConfigValues(device.configFields) : {}
		this.#devices.set(device.id, { device, emitter, session, budget, configValues })

		// Attach immediately, so a client that connects sees a live surface with no web UI involved.
		// An already-claimed session keeps whatever it was running before the reconnect.
		const previous = session.claimedBy ? this.scenarios.get(device.id)?.scenario : undefined
		this.scenarios.attach(device, emitter, previous ?? this.#unclaimedFor(session))

		// Companion sends DEVICE-CONFIG once immediately after ADD-DEVICE OK, so a client that declared
		// config fields has values before anyone has touched the UI. See docs/protocol.md §5.
		if (device.configFields) emitter.sendDeviceConfig(configValues)

		this.#logger.info({ device: device.id, claimCode: session.claimCode }, 'device attached')
	}

	/**
	 * Draw the "cannot pair" screen for a registration we accepted but did not register.
	 *
	 * Kept entirely outside `#devices`, which is keyed by device id — the id belongs to the other
	 * connection and putting this here would evict the real one, which is the exact takeover the
	 * whole check exists to prevent. It gets an emitter and a single static screen: nothing drives
	 * it, and input naming that id is refused upstream of here by the ownership check.
	 */
	#onDeviceRejected(connection: SatelliteSession, device: Device): void {
		const emitter = new SurfaceEmitter({
			device,
			connection: connection.connection,
			capabilities: connection.capabilities,
			renderer: this.renderer,
			budget: new RenderBudget(this.#config.MAX_BYTES_PER_SECOND * 4, surfacePixels(device)),
			onOverflow: () => connection.close(),
		})

		drawUnpairable(emitter, device.surface, device.id)

		this.#logger.warn(
			{ device: device.id, connection: connection.connection.id },
			'device id already registered by another connection — drew the unpairable screen. ' +
				'Companion would send nothing here; connect with ?duplicates=strict to reproduce that.'
		)
	}

	#onDeviceRemoved(device: Device): void {
		this.scenarios.detach(device.id)
		const runtime = this.#devices.get(device.id)
		this.#devices.delete(device.id)
		if (runtime) this.sessions.detach(runtime.session)
	}
}

/**
 * Total bitmap pixels in one full repaint of a surface.
 *
 * Used to size the render budget's burst so a cold full-surface paint always fits (see RenderBudget).
 * Controls the client did not ask a bitmap for contribute nothing.
 */
function surfacePixels(device: Device): number {
	let total = 0
	for (const control of device.surface.controls.values()) {
		if (control.style.bitmap) total += control.style.bitmap.w * control.style.bitmap.h
	}
	return total
}
