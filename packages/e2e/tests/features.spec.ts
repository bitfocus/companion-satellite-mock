import { TestSatelliteClient } from '@satellite-mock/testclient'
import { claim, decodeText, expect, readClaimCode, test } from './fixtures.js'

/**
 * Device config and subscriptions, through the UI.
 *
 * Both need a client that declares something the default fixture does not, so each test brings its
 * own second client. The assertions are on what that client *receives*, not on the UI's own state —
 * a form that looks right but pushes nothing is exactly the failure worth catching.
 */

const CONFIG_FIELDS = [
	{ id: 'label', label: 'Label', type: 'textinput', default: 'Studio A' },
	{ id: 'brightness', label: 'Max brightness', type: 'number', min: 10, max: 90, default: 50 },
	{
		id: 'mode',
		label: 'Mode',
		type: 'dropdown',
		default: 'live',
		choices: [
			{ id: 'live', label: 'Live' },
			{ id: 'rehearsal', label: 'Rehearsal' },
		],
	},
	{ id: 'invert', label: 'Invert display', type: 'checkbox', default: false },
	{ id: 'note', label: 'Note', type: 'static-text', value: 'Declared by the client' },
]

const decode = decodeText

const parseConfig = (client: TestSatelliteClient) => {
	const last = client.messagesOf('DEVICE-CONFIG').at(-1)
	return last ? (JSON.parse(decode(last.params.CONFIG)) as Record<string, unknown>) : undefined
}

test.describe('device config', () => {
	test('pushes DEVICE-CONFIG once immediately after registration', async ({ stack }) => {
		// The spec is explicit that this arrives without anyone touching the UI. It was documented in
		// docs/protocol.md and then not implemented for most of the build.
		const client = new TestSatelliteClient({ url: stack.satelliteUrl, pingIntervalMs: 0 })
		try {
			await client.connect()
			await client.addDevice('e2e:config', {
				KEYS_TOTAL: 4,
				KEYS_PER_ROW: 2,
				COLORS: 'hex',
				CONFIG_FIELDS: Buffer.from(JSON.stringify(CONFIG_FIELDS)).toString('base64'),
			})

			await client.waitFor('DEVICE-CONFIG', 10_000)
			expect(parseConfig(client)).toEqual({
				label: 'Studio A',
				brightness: 50,
				mode: 'live',
				invert: false,
			})
		} finally {
			client.close()
		}
	})

	test('renders the declared fields and pushes an edit back to the client', async ({ page, stack }) => {
		const client = new TestSatelliteClient({ url: stack.satelliteUrl, pingIntervalMs: 0 })
		try {
			await client.connect()
			await client.addDevice('e2e:config', {
				KEYS_TOTAL: 8,
				KEYS_PER_ROW: 4,
				COLORS: 'hex',
				// Without TEXT (or BITMAPS) the client never receives the code drawn on its own
				// surface, and could not be claimed at all — see docs/scenarios.md.
				TEXT: 1,
				CONFIG_FIELDS: Buffer.from(JSON.stringify(CONFIG_FIELDS)).toString('base64'),
			})
			await client.waitFor('DEVICE-CONFIG', 10_000)

			// Claim that device's session, not the fixture's.
			const states = await client.waitForCount('KEY-STATE', 8, 10_000)
			const code = readClaimCode(states.map((message) => decode(message.params.TEXT)))

			await page.goto(stack.webUrl)
			await page.fill('input[aria-label="Claim code"]', code)
			await page.click('button[type="submit"]')
			await page.waitForSelector('.grid img')

			const panel = page.getByTestId('config-panel')
			await expect(panel).toContainText('Label')
			await expect(panel).toContainText('Declared by the client')
			await expect(panel.getByTestId('config-label')).toHaveValue('Studio A')

			client.clearReceived()
			await panel.getByTestId('config-label').fill('Studio B')
			await panel.getByTestId('config-label').blur()

			await client.waitFor('DEVICE-CONFIG', 10_000)
			expect(parseConfig(client)?.label).toBe('Studio B')
		} finally {
			client.close()
		}
	})

	test('says so plainly when the client declared no fields', async ({ page, stack }) => {
		await claim(page, stack)
		await expect(page.getByTestId('config-panel')).toContainText('declared no')
	})
})

test.describe('subscriptions', () => {
	test('lists a subscription and pushes content to the location it watches', async ({ page, stack }) => {
		await claim(page, stack)

		// The fixture's client holds the claimed session, so its subscription is the one listed.
		stack.client.sendMessage('ADD-SUB', { SUBID: 'watch/1', LOCATION: '4/1/2', COLORS: 'hex', TEXT: 1 })
		await stack.client.waitFor('SUB-STATE', 10_000)

		const panel = page.getByTestId('subscriptions-panel')
		await expect(panel).toContainText('watch/1')
		await expect(panel).toContainText('4/1/2')

		stack.client.clearReceived()
		await panel.getByLabel('Subscription text').fill('ON AIR')
		await panel.getByRole('button', { name: 'Push to location' }).click()

		const states = await stack.client.waitForCount('SUB-STATE', 1, 10_000)
		expect(decode(states[0]!.params.TEXT)).toBe('ON AIR')
		await expect(panel).toContainText('Pushed to 1 subscription')
	})

	test('says so plainly when the client has none', async ({ page, stack }) => {
		await claim(page, stack)
		await expect(page.getByTestId('subscriptions-panel')).toContainText('no subscriptions')
	})
})

/**
 * The reconnect tools.
 *
 * A plain disconnect only proves the client noticed. What breaks in the field is the loop that
 * follows, and neither the status code the client is given nor a server that stays unreachable is
 * observable from a unit test — both need a real socket to a real listener.
 */
test.describe('disconnect and reconnect', () => {
	test('closes with the status code the operator chose', async ({ page, stack }) => {
		await claim(page, stack)

		const closed = new Promise<number>((resolve) => stack.client.once('close', (code) => resolve(code)))

		await page.getByTestId('close-code').selectOption('1013')
		await page.getByTestId('blackout-seconds').fill('0')
		await page.getByTestId('disconnect-with-code').click()

		// 1013 "try again later" rather than the 1006 an abrupt terminate produces.
		expect(await closed).toBe(1013)
	})

	test('refuses the client back while the blackout runs, then lets it in', async ({ page, stack }) => {
		await claim(page, stack)

		const closed = new Promise<void>((resolve) => stack.client.once('close', () => resolve()))
		await page.getByTestId('blackout-seconds').fill('3')
		await page.getByTestId('disconnect-with-code').click()
		await closed

		await expect(page.getByTestId('blackout-status')).toBeVisible()

		// A reconnect during the blackout is refused with 1013 rather than admitted.
		const refused = new TestSatelliteClient({ url: stack.satelliteUrl, pingIntervalMs: 0 })
		const refusedCode = new Promise<number>((resolve) => refused.once('close', (code) => resolve(code)))
		await refused.connect()
		expect(await refusedCode).toBe(1013)

		// And once it expires the client gets back in, which is the half that proves it is a
		// blackout rather than a ban.
		const later = new TestSatelliteClient({ url: stack.satelliteUrl, pingIntervalMs: 0 })
		await expect
			.poll(
				async () => {
					try {
						await later.connect()
						const begin = await later.waitFor('BEGIN', 2000)
						return begin.command
					} catch {
						later.close()
						return null
					}
				},
				{ timeout: 15_000, intervals: [500] }
			)
			.toBe('BEGIN')
		later.close()
	})

	test('clearing the blackout lets the client straight back in', async ({ page, stack }) => {
		await claim(page, stack)

		const closed = new Promise<void>((resolve) => stack.client.once('close', () => resolve()))
		await page.getByTestId('blackout-seconds').fill('60')
		await page.getByTestId('disconnect-with-code').click()
		await closed

		await expect(page.getByTestId('blackout-status')).toBeVisible()
		await page.getByTestId('clear-blackout').click()
		await expect(page.getByTestId('blackout-status')).toBeHidden()

		const back = new TestSatelliteClient({ url: stack.satelliteUrl, pingIntervalMs: 0 })
		await back.connect()
		expect((await back.waitFor('BEGIN', 5000)).command).toBe('BEGIN')
		back.close()
	})
})
