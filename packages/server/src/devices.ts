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

	/**
	 * Register a device. An id that is already taken is left alone and `false` is returned.
	 *
	 * The duplicate *rules* deliberately live in the ADD-DEVICE handler, not here, because which
	 * socket is told what depends on error ordering: upstream checks for a duplicate before parsing
	 * `LAYOUT_MANIFEST`, so a request that is both a duplicate and malformed reports the duplicate.
	 * Enforcing that here would move the check after the surface is built and silently change which
	 * error a client sees.
	 *
	 * This still refuses to overwrite, so if that handler check ever regresses the failure is a
	 * device that will not register rather than one client silently taking over another's id.
	 */
	add(device: Device): boolean {
		if (this.#devices.has(device.id)) return false
		this.#devices.set(device.id, device)
		return true
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
