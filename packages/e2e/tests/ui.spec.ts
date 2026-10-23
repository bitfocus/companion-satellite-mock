import { claim, expect, openTab, test } from './fixtures.js'

test.describe('claiming', () => {
	test('shows the connection URL and claims with the code drawn on the surface', async ({ page, stack }) => {
		await page.goto(stack.webUrl)

		await expect(page.getByRole('heading', { name: 'Satellite Mock' })).toBeVisible()
		await expect(page.locator('code.url')).toContainText('/ws/satellite')

		// Six characters, read off the buttons rather than copied out of the app.
		expect(stack.claimCode).toHaveLength(6)

		await page.fill('input[aria-label="Claim code"]', stack.claimCode)
		await page.click('button[type="submit"]')
		await expect(page.locator('.grid img')).toHaveCount(8)
	})

	test('accepts the code in its displayed hyphenated form', async ({ page, stack }) => {
		await page.goto(stack.webUrl)
		const displayed = `${stack.claimCode.slice(0, 3)}-${stack.claimCode.slice(3)}`
		await page.fill('input[aria-label="Claim code"]', displayed)
		await page.click('button[type="submit"]')
		await expect(page.locator('.grid img')).toHaveCount(8)
	})

	test('reports a wrong code without leaving the claim page', async ({ page, stack }) => {
		await page.goto(stack.webUrl)
		await page.fill('input[aria-label="Claim code"]', 'ZZZZZZ')
		await page.click('button[type="submit"]')

		await expect(page.locator('.error')).toContainText('No session with that code')
		await expect(page.locator('input[aria-label="Claim code"]')).toBeVisible()
	})
})

test.describe('the session view', () => {
	test('mirrors every control with a rendered preview', async ({ page, stack }) => {
		await claim(page, stack)

		const tiles = page.locator('.grid img')
		await expect(tiles).toHaveCount(8)
		// Previews are real images, not placeholders.
		for (const src of await tiles.evaluateAll((images) => images.map((i) => (i as HTMLImageElement).src))) {
			expect(src.startsWith('data:image/png;base64,')).toBe(true)
			expect(src.length).toBeGreaterThan(200)
		}
	})

	test('shows the device the client actually registered', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Device')

		const device = page.getByTestId('device-panel')
		await expect(device).toContainText('e2e:surface')
		await expect(device).toContainText('4×2 (legacy)')
		await expect(page.locator('.badge')).toHaveText('connected')
	})

	test('trace shows real protocol traffic and not a wall of keepalives', async ({ page, stack }) => {
		// The regression that made these tests worth writing. The client pings at 10Hz, so if
		// keepalives ever reach the trace again they bury everything within seconds.
		await claim(page, stack)
		await openTab(page, 'Log')

		const trace = page.getByTestId('trace-panel').locator('.trace li code')
		await expect(trace.first()).toBeVisible()

		const lines = await trace.allTextContents()
		expect(lines.some((line) => line.startsWith('KEY-STATE'))).toBe(true)
		expect(lines.some((line) => line.startsWith('PING') || line.startsWith('PONG'))).toBe(false)
	})

	test('elides bitmap payloads so the trace stays readable', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Log')
		const lines = await page.getByTestId('trace-panel').locator('.trace li code').allTextContents()
		const keyState = lines.find((line) => line.startsWith('KEY-STATE'))

		expect(keyState).toBeDefined()
		expect(keyState).toContain('BITMAP=<')
		// A raw 72px bitmap is ~20KB of base64; anything near that means elision broke.
		expect(keyState!.length).toBeLessThan(400)
	})

	test('counts keepalives in the device panel', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Device')
		const device = page.getByTestId('device-panel')
		await expect(device).toContainText('in /')
		await expect(device).toContainText('ago')
	})

	test('filters the trace', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Log')
		await page.fill('input[aria-label="Filter trace"]', 'ADD-DEVICE')

		const lines = await page.getByTestId('trace-panel').locator('.trace li code').allTextContents()
		expect(lines.length).toBeGreaterThan(0)
		expect(lines.every((line) => line.includes('ADD-DEVICE'))).toBe(true)
	})
})

test.describe('scenarios', () => {
	test('switching redraws the surface with the new content', async ({ page, stack }) => {
		await claim(page, stack)
		await page.click('button.scenario:has-text("Colour & text matrix")')

		await expect(page.locator('button.scenario.active')).toContainText('Colour & text matrix')
		// Assert on what the client received, not just on the UI's own state.
		await expect
			.poll(async () => {
				const texts = stack.client
					.messagesOf('KEY-STATE')
					.map((m) => Buffer.from(String(m.params.TEXT ?? ''), 'base64').toString())
				return texts.some((text) => text.includes('MiXeD CaSe'))
			})
			.toBe(true)
	})

	test('lists every scenario with a description', async ({ page, stack }) => {
		await claim(page, stack)
		const scenarios = page.locator('button.scenario')

		await expect(scenarios).toHaveCount(8)
		for (const text of await scenarios.locator('span').allTextContents()) {
			expect(text.length).toBeGreaterThan(20)
		}
	})
})

test.describe('fault injection', () => {
	test('applies a knob and the client still works through it', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Network')

		const slider = page.getByTestId('chaos-panel').locator('.slider:has-text("Split into frames") input')
		await slider.fill('16')
		await slider.dispatchEvent('change')
		await expect(page.locator('.slider:has-text("Split into frames") em')).toHaveText('16')

		// The real assertion: with lines split across frames, a correct client still parses them.
		stack.client.clearReceived()
		await openTab(page, 'Surface')
		await page.click('button.scenario:has-text("Colour & text matrix")')
		const states = await stack.client.waitForCount('KEY-STATE', 8, 15_000)
		expect(states.length).toBeGreaterThanOrEqual(8)
	})

	test('resets every knob', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Network')
		const slider = page.getByTestId('chaos-panel').locator('.slider:has-text("Latency (ms)") input')
		await slider.fill('500')
		await slider.dispatchEvent('change')
		await expect(page.locator('.slider:has-text("Latency (ms)") em')).toHaveText('500')

		await page.getByTestId('chaos-panel').getByRole('button', { name: 'Reset all' }).click()
		await expect(page.locator('.slider:has-text("Latency (ms)") em')).toHaveText('0')
	})

	test('builds a version URL that selects an older server', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Network')
		const panel = page.getByTestId('version-panel')

		await panel.locator('select').first().selectOption('1.9.0')
		await expect(panel.locator('code.url')).toContainText('api=1.9.0')

		await panel.locator('input[type="checkbox"]').uncheck()
		await expect(panel.locator('code.url')).toContainText('subs=0')
	})
})

test.describe('connection controls', () => {
	test('sends a raw line to the client', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Log')
		stack.client.clearReceived()

		await page.fill('input[aria-label="Raw protocol line"]', 'KEYS-CLEAR DEVICEID=e2e:surface')
		await page.getByTestId('raw-panel').getByRole('button', { name: 'Send' }).click()

		await stack.client.waitFor('KEYS-CLEAR', 10_000)
	})

	test('refuses a raw line that would corrupt the wire format', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Log')
		await page.fill('input[aria-label="Raw protocol line"]', 'X TEXT="oops')
		await page.getByTestId('raw-panel').getByRole('button', { name: 'Send' }).click()

		await expect(page.getByTestId('toast')).toContainText('quotes or newlines')
	})

	test('force-disconnects the client and reflects it in the UI', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Network')
		const closed = new Promise<void>((resolve) => stack.client.once('close', () => resolve()))

		// No blackout: this test is about the UI noticing the client is gone, not about reconnects.
		await page.getByTestId('blackout-seconds').fill('0')
		await page.getByTestId('disconnect-with-code').click()
		await closed
		await expect(page.locator('.badge')).toHaveText('offline', { timeout: 15_000 })
	})

	test('unclaiming returns to the claim page with a fresh code', async ({ page, stack }) => {
		await claim(page, stack)
		await openTab(page, 'Network')
		await page.getByTestId('connection-panel').getByRole('button', { name: 'Unclaim' }).click()

		await expect(page.getByRole('heading', { name: 'Satellite Mock' })).toBeVisible()
		// The old code no longer works, because unclaiming mints a new one.
		await page.fill('input[aria-label="Claim code"]', stack.claimCode)
		await page.click('button[type="submit"]')
		await expect(page.locator('.error')).toContainText('No session with that code')
	})
})
