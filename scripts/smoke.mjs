#!/usr/bin/env node
/**
 * Post-deploy smoke test.
 *
 * Connects a real client and asserts it gets what a first-time user would: a handshake, an
 * accepted surface, and a live Unclaimed screen with a claim code drawn on it. That last part is
 * the thing worth checking after a deploy — a server that accepts connections but draws nothing
 * looks healthy to /healthz and is useless to whoever is trying to connect.
 *
 * Usage: node scripts/smoke.mjs [ws://host:16623/ws/satellite]
 */
import { TestSatelliteClient } from '../packages/testclient/dist/index.js'

const url = process.argv[2] ?? 'ws://127.0.0.1:16623/ws/satellite'
const deviceId = `smoke:${Date.now()}`

const fail = (message) => {
	console.error(`FAIL  ${message}`)
	process.exit(1)
}
const pass = (message) => console.log(`ok    ${message}`)

const client = new TestSatelliteClient({ url, pingIntervalMs: 100 })
const timeout = setTimeout(() => fail('timed out'), 20_000)

try {
	await client.connect()
	pass(`connected to ${url}`)

	const begin = await client.waitFor('BEGIN')
	if (!begin.params.ApiVersion) fail('BEGIN carried no ApiVersion')
	pass(`handshake, API ${String(begin.params.ApiVersion)}`)

	const added = await client.addDevice(deviceId, {
		KEYS_TOTAL: 32,
		KEYS_PER_ROW: 8,
		COLORS: 'hex',
		TEXT: 1,
		BITMAPS: 72,
	})
	if (added.line.includes('ERROR')) fail(`ADD-DEVICE rejected: ${added.line}`)
	pass('surface registered')

	const states = await client.waitForCount('KEY-STATE', 32, 10_000)
	pass(`${states.length} controls drawn`)

	const texts = states.map((m) => Buffer.from(String(m.params.TEXT ?? ''), 'base64').toString())
	if (!texts.join(' ').replace(/-?\n/g, '').includes('UNCLAIMED')) {
		fail('surface did not show the Unclaimed screen')
	}
	pass('Unclaimed screen shown')

	const code = texts.filter((text) => text.length === 1).join('')
	if (code.length < 6) fail(`claim code not drawn (got ${JSON.stringify(code)})`)
	pass(`claim code drawn: ${code}`)

	const bitmaps = states.filter((m) => typeof m.params.BITMAP === 'string')
	if (bitmaps.length === 0) fail('no bitmaps streamed')
	const size = Buffer.from(String(bitmaps[0].params.BITMAP), 'base64').length
	if (size !== 72 * 72 * 3) fail(`bitmap was ${size} bytes, expected ${72 * 72 * 3}`)
	pass(`bitmaps streamed at the negotiated size (${size} bytes)`)

	// A blank bitmap means the container has no fonts, which /healthz cannot tell you.
	if (!bitmaps.some((m) => Buffer.from(String(m.params.BITMAP), 'base64').some((byte) => byte > 200))) {
		fail('every bitmap was dark — fonts missing from the image?')
	}
	pass('bitmaps contain rendered content')

	clearTimeout(timeout)
	client.close()
	console.log('\nsmoke test passed')
	process.exit(0)
} catch (error) {
	fail(error instanceof Error ? error.message : String(error))
}
