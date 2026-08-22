import { pino } from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, type Config } from './config.js'
import { MetricsServer } from './metrics.js'

/**
 * The metrics listener's access control is a security property, not a convenience.
 *
 * It was previously only ever checked by hand with curl. On a public instance this endpoint is the
 * one thing that leaks operational internals, so the 404-not-401 behaviour and the constant-time
 * comparison belong in the suite.
 */

const logger = pino({ level: 'silent' })
const servers: MetricsServer[] = []

async function start(overrides: Partial<Config> = {}) {
	const config = { ...loadConfig({ NODE_ENV: 'test' }), METRICS_PORT: 0, METRICS_BIND: '127.0.0.1', ...overrides }
	const metrics = new MetricsServer(config, logger)
	await metrics.listen()
	servers.push(metrics)
	return { metrics, url: `http://127.0.0.1:${metrics.address!.port}` }
}

afterEach(async () => {
	for (const metrics of servers.splice(0)) await metrics.close()
})

describe('MetricsServer', () => {
	it('serves metrics when no token is configured', async () => {
		const { url } = await start()
		const response = await fetch(`${url}/metrics`)

		expect(response.status).toBe(200)
		expect(await response.text()).toContain('nodejs_')
	})

	it('answers 404 rather than 401 without a token, so a prober cannot confirm it exists', async () => {
		const { url } = await start({ METRICS_TOKEN: 'a-long-enough-secret-token' })
		const response = await fetch(`${url}/metrics`)

		expect(response.status).toBe(404)
		expect(await response.text()).not.toContain('nodejs_')
	})

	it('answers 404 for a wrong token', async () => {
		const { url } = await start({ METRICS_TOKEN: 'a-long-enough-secret-token' })
		const response = await fetch(`${url}/metrics`, { headers: { Authorization: 'Bearer wrong-token-entirely' } })
		expect(response.status).toBe(404)
	})

	it('answers 404 for a token that is a prefix of the real one', async () => {
		// The length check has to come before timingSafeEqual, which throws on a length mismatch.
		const { url } = await start({ METRICS_TOKEN: 'a-long-enough-secret-token' })
		const response = await fetch(`${url}/metrics`, { headers: { Authorization: 'Bearer a-long-enough' } })
		expect(response.status).toBe(404)
	})

	it('serves metrics with the right token', async () => {
		const token = 'a-long-enough-secret-token'
		const { url } = await start({ METRICS_TOKEN: token })
		const response = await fetch(`${url}/metrics`, { headers: { Authorization: `Bearer ${token}` } })

		expect(response.status).toBe(200)
		expect(await response.text()).toContain('nodejs_')
	})

	it('serves nothing at any other path', async () => {
		// The check is exact string equality on req.url, which is the strictest form — no prefix
		// matching to trick and no path to traverse. Note `/../metrics` cannot be tested through
		// fetch: it normalises the path to `/metrics` before sending, so the server legitimately
		// sees a valid request. Exact equality is what makes traversal irrelevant anyway.
		const { url } = await start()
		for (const path of ['/', '/healthz', '/metrics/', '/metricsx', '/Metrics']) {
			expect((await fetch(`${url}${path}`)).status, path).toBe(404)
		}
	})

	it('exposes the satellite metric families', async () => {
		const { metrics, url } = await start()
		metrics.connections.set({ transport: 'ws' }, 3)
		metrics.messages.inc({ direction: 'in', command: 'PING' }, 5)
		metrics.claimAttempts.inc({ result: 'failed' }, 2)

		const body = await (await fetch(`${url}/metrics`)).text()
		expect(body).toContain('satellite_connections{transport="ws"} 3')
		expect(body).toContain('satellite_messages_total{direction="in",command="PING"} 5')
		expect(body).toContain('satellite_claim_attempts_total{result="failed"} 2')
	})
})

describe('config', () => {
	it('rejects a token too short to be worth having', () => {
		expect(() => loadConfig({ METRICS_TOKEN: 'short' })).toThrow(/Invalid configuration/)
	})

	it('defaults metrics to loopback, so the default is closed', () => {
		expect(loadConfig({}).METRICS_BIND).toBe('127.0.0.1')
	})

	it('defaults to trusting no proxies, so X-Forwarded-For cannot be forged', () => {
		expect(loadConfig({}).TRUSTED_PROXY_HOPS).toBe(0)
	})

	it('rejects an out-of-range port or a negative limit', () => {
		expect(() => loadConfig({ SATELLITE_PORT: '99999' })).toThrow()
		expect(() => loadConfig({ MAX_CONNECTIONS_PER_IP: '-1' })).toThrow()
		expect(() => loadConfig({ TRUSTED_PROXY_HOPS: '99' })).toThrow()
	})

	it('coerces numeric strings, since everything arrives as an env var', () => {
		const config = loadConfig({ SATELLITE_PORT: '1234', MAX_CONNECTIONS_PER_IP: '9' })
		expect(config.SATELLITE_PORT).toBe(1234)
		expect(config.MAX_CONNECTIONS_PER_IP).toBe(9)
	})

	it('keeps the frame cap above the line cap by default', () => {
		// They are separate limits; a frame cap below the line cap would disconnect a client that
		// batches its writes.
		const config = loadConfig({})
		expect(config.MAX_FRAME_BYTES).toBeGreaterThan(config.MAX_LINE_BYTES)
	})
})
