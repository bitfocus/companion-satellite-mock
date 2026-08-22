import { existsSync, readdirSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

/**
 * Find a Chromium that is already on the machine.
 *
 * CI images and this dev container ship a browser at PLAYWRIGHT_BROWSERS_PATH; downloading another
 * copy per run is slow and, in a sandbox with no egress, impossible. Falling back to Playwright's
 * own resolution keeps it working on a normal laptop.
 */
function findChromium(): string | undefined {
	const root = process.env.PLAYWRIGHT_BROWSERS_PATH
	if (!root || !existsSync(root)) return undefined

	const dir = readdirSync(root).find((entry) => entry.startsWith('chromium-'))
	if (!dir) return undefined

	const candidate = `${root}/${dir}/chrome-linux/chrome`
	return existsSync(candidate) ? candidate : undefined
}

const executablePath = findChromium()

export default defineConfig({
	testDir: './tests',
	// The UI is driven against a real server with a real satellite client attached, so tests share
	// ports and must not race each other.
	workers: 1,
	fullyParallel: false,
	timeout: 30_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI ? [['github'], ['list']] : [['list']],
	use: {
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		...(executablePath ? { launchOptions: { executablePath, args: ['--no-sandbox'] } } : {}),
	},
})
