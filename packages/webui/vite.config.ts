import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
	plugins: [react()],
	build: { outDir: 'dist', sourcemap: true },
	server: {
		// The dev server proxies to the mock so the UI is same-origin in development too, matching
		// production, where the server serves the built assets itself.
		proxy: {
			'/ws/trpc': { target: 'ws://127.0.0.1:16624', ws: true },
		},
	},
})
