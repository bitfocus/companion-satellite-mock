import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test as base, type Page } from '@playwright/test'
import { TestSatelliteClient } from '@satellite-mock/testclient'

/**
 * Starts a real server and attaches a real satellite client for each test.
 *
 * Nothing is stubbed. The point of these tests is the wiring between the browser, the API and the
 * protocol — the two UI bugs that made these worth writing (a trace full of keepalives, and
 * KEY-STATE never reaching the trace at all) were both invisible to unit tests and obvious the
 * moment a real client was on the other end.
 */

const SERVER_ENTRY = fileURLToPath(new URL('../../server/dist/main.js', import.meta.url))

export interface Stack {
	webUrl: string
	satelliteUrl: string
	client: TestSatelliteClient
	/** The claim code, read off the rendered surface exactly as a user would. */
	claimCode: string
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			const response = await fetch(`${url}/healthz`)
			if (response.ok) return
		} catch {
			// Not up yet.
		}
		if (Date.now() > deadline) throw new Error(`server did not become healthy at ${url}`)
		await new Promise((resolve) => setTimeout(resolve, 200))
	}
}

/** Ports are per-worker so a re-run does not collide with a leftover process. */
function ports(): { satellite: number; web: number; metrics: number } {
	const base = 17600 + (Number(process.env.TEST_WORKER_INDEX ?? 0) % 20) * 10
	return { satellite: base, web: base + 1, metrics: base + 2 }
}

export const test = base.extend<{ stack: Stack }>({
	// Playwright detects fixture dependencies by destructuring the first argument, so a fixture with
	// no dependencies still has to destructure an empty object.
	// eslint-disable-next-line no-empty-pattern
	stack: async ({}, use) => {
		const { satellite, web, metrics } = ports()
		let child: ChildProcess | undefined
		let client: TestSatelliteClient | undefined

		try {
			child = spawn(process.execPath, [SERVER_ENTRY], {
				env: {
					...process.env,
					NODE_ENV: 'production',
					LOG_LEVEL: 'silent',
					SATELLITE_PORT: String(satellite),
					WEB_PORT: String(web),
					METRICS_PORT: String(metrics),
					// No PUBLIC_ORIGIN: the Origin check only applies when one is configured, and the
					// browser here is same-origin anyway.
				},
				stdio: 'ignore',
			})

			const webUrl = `http://127.0.0.1:${web}`
			const satelliteUrl = `ws://127.0.0.1:${satellite}/ws/satellite`
			await waitForHealth(webUrl)

			client = new TestSatelliteClient({ url: satelliteUrl, pingIntervalMs: 100 })
			await client.connect()
			await client.addDevice('e2e:surface', {
				KEYS_TOTAL: 8,
				KEYS_PER_ROW: 4,
				COLORS: 'hex',
				TEXT: 1,
				BITMAPS: 72,
			})

			const states = await client.waitForCount('KEY-STATE', 8, 15_000)
			// Read the code off the surface, exactly as a user does — this also asserts the whole
			// unclaimed path works before any test body runs.
			const claimCode = states
				.map((message) => Buffer.from(String(message.params.TEXT ?? ''), 'base64').toString())
				.filter((text) => text.length === 1)
				.join('')

			await use({ webUrl, satelliteUrl, client, claimCode })
		} finally {
			client?.close()
			child?.kill('SIGTERM')
		}
	},
})

export { expect } from '@playwright/test'

/** Claim the session in the browser and wait for the surface mirror to appear. */
export async function claim(page: Page, stack: Stack): Promise<void> {
	await page.goto(stack.webUrl)
	await page.fill('input[aria-label="Claim code"]', stack.claimCode)
	await page.click('button[type="submit"]')
	await page.waitForSelector('.grid img')
}
