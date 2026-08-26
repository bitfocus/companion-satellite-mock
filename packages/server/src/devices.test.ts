import { describe, expect, it } from 'vitest'
import { DeviceRegistry, type Device } from './devices.js'
import type { SatelliteConnection } from './transport/types.js'

/**
 * The registry had no tests of its own, which is how an unused duplicate-handling API survived in it
 * while the real rules lived in the ADD-DEVICE handler. These cover what it is actually responsible
 * for: global ids, ownership, and per-connection cleanup.
 */

const connection = (id: string) => ({ id, kind: 'ws', remoteAddress: '198.51.100.7' }) as SatelliteConnection

const device = (id: string, conn: SatelliteConnection): Device =>
	({ id, serial: id, connection: conn, addedAt: 0, firmwareUpdateUrl: null }) as unknown as Device

describe('DeviceRegistry', () => {
	it('registers a device and finds it again', () => {
		const registry = new DeviceRegistry()
		const a = connection('a')

		expect(registry.add(device('dev1', a))).toBe(true)
		expect(registry.get('dev1')?.connection).toBe(a)
		expect(registry.size).toBe(1)
	})

	it('refuses a duplicate id rather than letting the second connection take it over', () => {
		const registry = new DeviceRegistry()
		const first = connection('first')
		const second = connection('second')
		registry.add(device('dev1', first))

		expect(registry.add(device('dev1', second))).toBe(false)
		// The point of the check: the original holder keeps it.
		expect(registry.get('dev1')?.connection).toBe(first)
		expect(registry.size).toBe(1)
	})

	it('refuses a duplicate from the same connection too', () => {
		const registry = new DeviceRegistry()
		const a = connection('a')
		registry.add(device('dev1', a))

		expect(registry.add(device('dev1', a))).toBe(false)
	})

	it('ids are global, so a second connection can still use a different one', () => {
		const registry = new DeviceRegistry()
		registry.add(device('dev1', connection('first')))

		expect(registry.add(device('dev2', connection('second')))).toBe(true)
		expect(registry.size).toBe(2)
	})

	it('getOwned refuses a device that belongs to another connection', () => {
		const registry = new DeviceRegistry()
		const owner = connection('owner')
		const other = connection('other')
		registry.add(device('dev1', owner))

		expect(registry.getOwned('dev1', owner)?.id).toBe('dev1')
		// Without this, any connection could drive any surface by guessing its id.
		expect(registry.getOwned('dev1', other)).toBeUndefined()
	})

	it('removes everything belonging to one connection and nothing else', () => {
		const registry = new DeviceRegistry()
		const going = connection('going')
		const staying = connection('staying')
		registry.add(device('dev1', going))
		registry.add(device('dev2', going))
		registry.add(device('dev3', staying))

		const removed = registry.removeAllFor(going)

		expect(removed.map((entry) => entry.id).sort()).toEqual(['dev1', 'dev2'])
		expect(registry.size).toBe(1)
		expect(registry.get('dev3')).toBeDefined()
	})

	it('frees an id once its connection has gone, so the client can re-register', () => {
		const registry = new DeviceRegistry()
		const first = connection('first')
		registry.add(device('dev1', first))
		registry.removeAllFor(first)

		const second = connection('second')
		expect(registry.add(device('dev1', second))).toBe(true)
		expect(registry.get('dev1')?.connection).toBe(second)
	})
})
