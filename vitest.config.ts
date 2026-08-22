import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Only unit and integration tests. The e2e suite is Playwright and runs separately, because
		// it needs a built server and a browser.
		include: ['packages/*/src/**/*.test.ts'],
		exclude: ['**/node_modules/**', 'packages/e2e/**'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			include: ['packages/*/src/**/*.ts'],
			exclude: ['packages/*/src/**/*.test.ts'],
		},
	},
})
