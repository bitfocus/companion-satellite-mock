import type { SatelliteControlStylePreset, BitmapFormat } from '@satellite-mock/protocol'
import type { ButtonStyle } from './render/buttonStyle.js'
import type { Device } from './devices.js'
import type { SatelliteSession } from './satelliteSession.js'

export interface ControlLocation {
	pageNumber: number
	row: number
	column: number
}

export interface Subscription {
	readonly subId: string
	readonly location: ControlLocation
	readonly style: SatelliteControlStylePreset
	readonly bitmapFormat: BitmapFormat
}

/**
 * Everything the protocol layer reports upwards.
 *
 * The scenario engine and the web UI subscribe here; the protocol layer itself never knows they
 * exist, which is what keeps `satelliteSession.ts` about the wire and only the wire. Every handler
 * is optional so a bare protocol server — the transport tests, for one — needs none of them.
 */
export interface SatelliteEvents {
	/**
	 * Every line in and out, for the protocol trace.
	 *
	 * Separate from the typed events because the trace has to show what actually crossed the wire,
	 * including malformed input and lines no handler understood — a trace assembled from parsed
	 * events would hide exactly the cases someone opens a trace to debug.
	 */
	onLine?: (session: SatelliteSession, direction: 'in' | 'out', line: string) => void

	/**
	 * Connection lifecycle, independent of any device.
	 *
	 * Needed because a connection can hold subscriptions without ever registering a device —
	 * subscriptions reference an absolute location, not a surface — so anything tracking "who is
	 * connected" cannot derive it from devices or from UI sessions.
	 */
	onConnectionOpen?: (session: SatelliteSession) => void
	onConnectionClose?: (session: SatelliteSession) => void
	onDeviceAdded?: (session: SatelliteSession, device: Device) => void
	onDeviceRemoved?: (session: SatelliteSession, device: Device) => void
	onKeyPress?: (session: SatelliteSession, device: Device, controlId: string, pressed: boolean) => void
	onKeyRotate?: (session: SatelliteSession, device: Device, controlId: string, delta: number) => void
	onPincodeKey?: (session: SatelliteSession, device: Device, digit: number) => void
	onVariableValue?: (session: SatelliteSession, device: Device, variable: string, value: string) => void
	onFirmwareUpdateInfo?: (session: SatelliteSession, device: Device, url: string | null) => void
	onChangePage?: (session: SatelliteSession, device: Device, forward: boolean) => void
	onSubscriptionAdded?: (session: SatelliteSession, subscription: Subscription) => void

	/**
	 * What a subscribed location currently shows.
	 *
	 * The initial `SUB-STATE` is sent by the command handler, which is the only place that knows the
	 * subscription was accepted — so it asks for the content rather than a second layer sending a
	 * follow-up. An earlier version had both doing it, which produced a blank state and then a real
	 * one, and worked only if the second layer happened to be wired up. Absent, the location is
	 * blank, which is a valid subscription target.
	 */
	resolveSubscriptionContent?: (subscription: Subscription) => ButtonStyle | undefined
	onSubPress?: (session: SatelliteSession, subscription: Subscription, pressed: boolean) => void
	onSubRotate?: (session: SatelliteSession, subscription: Subscription, delta: number) => void
}
