import type { SatelliteControlStylePreset, BitmapFormat } from '@satellite-mock/protocol'
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
	onDeviceAdded?: (session: SatelliteSession, device: Device) => void
	onDeviceRemoved?: (session: SatelliteSession, device: Device) => void
	onKeyPress?: (session: SatelliteSession, device: Device, controlId: string, pressed: boolean) => void
	onKeyRotate?: (session: SatelliteSession, device: Device, controlId: string, delta: number) => void
	onPincodeKey?: (session: SatelliteSession, device: Device, digit: number) => void
	onVariableValue?: (session: SatelliteSession, device: Device, variable: string, value: string) => void
	onFirmwareUpdateInfo?: (session: SatelliteSession, device: Device, url: string | null) => void
	onChangePage?: (session: SatelliteSession, device: Device, forward: boolean) => void
	onSubscriptionAdded?: (session: SatelliteSession, subscription: Subscription) => void
	onSubPress?: (session: SatelliteSession, subscription: Subscription, pressed: boolean) => void
	onSubRotate?: (session: SatelliteSession, subscription: Subscription, delta: number) => void
}
