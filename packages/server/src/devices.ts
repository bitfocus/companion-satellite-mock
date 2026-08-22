import type { BitmapFormat, SatelliteConfigFields, Surface, TransferableValue } from '@satellite-mock/protocol'
import type { SatelliteConnection } from './transport/types.js'

/** A surface registered by a client. */
export interface Device {
	readonly id: string
	readonly serial: string
	readonly serialIsUnique: boolean
	readonly productName: string
	readonly connection: SatelliteConnection
	readonly surface: Surface
	readonly bitmapFormat: BitmapFormat
	readonly supportsBrightness: boolean
	readonly supportsLockedState: false | 'FULL' | 'PARTIAL'
	readonly canChangePage: string | undefined
	readonly variables: readonly TransferableValue[]
	readonly configFields: SatelliteConfigFields | undefined
	readonly addedAt: number
	/** Reported by the client via FIRMWARE-UPDATE-INFO. Displayed as inert text; never fetched. */
	firmwareUpdateUrl: string | null
}

export type AddDeviceResult =
	| { ok: true }
	/** The id is taken on this same connection — the requesting socket is told. */
	| { ok: false; reason: 'already-added' }
	/**
	 * The id is taken on a *different* connection. Upstream tells the EXISTING socket, and sends the
	 * requesting one nothing at all — a quirk, but one a client may well be relying on to notice it
	 * has been displaced.
	 */
	| { ok: false; reason: 'exists-elsewhere'; existing: Device }

/**
 * Registry of every device across every connection.
 *
 * Server-wide rather than per-connection, because device ids are global in Companion: that is what
 * makes "Device exists elsewhere" possible, and what stops two clients claiming the same surface.
 */
export class DeviceRegistry {
	readonly #devices = new Map<string, Device>()

	get size(): number {
		return this.#devices.size
	}

	get(id: string): Device | undefined {
		return this.#devices.get(id)
	}

	/** Look up a device, but only if it belongs to this connection — upstream's ownership check. */
	getOwned(id: string, connection: SatelliteConnection): Device | undefined {
		const device = this.#devices.get(id)
		return device && device.connection === connection ? device : undefined
	}

	add(device: Device): AddDeviceResult {
		const existing = this.#devices.get(device.id)
		if (existing) {
			return existing.connection === device.connection
				? { ok: false, reason: 'already-added' }
				: { ok: false, reason: 'exists-elsewhere', existing }
		}
		this.#devices.set(device.id, device)
		return { ok: true }
	}

	remove(id: string): boolean {
		return this.#devices.delete(id)
	}

	/** Remove everything belonging to a connection, returning what was removed. */
	removeAllFor(connection: SatelliteConnection): Device[] {
		const removed: Device[] = []
		for (const [id, device] of this.#devices) {
			if (device.connection === connection) {
				this.#devices.delete(id)
				removed.push(device)
			}
		}
		return removed
	}

	forConnection(connection: SatelliteConnection): Device[] {
		return [...this.#devices.values()].filter((device) => device.connection === connection)
	}

	all(): Device[] {
		return [...this.#devices.values()]
	}
}
