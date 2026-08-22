import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{ ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.yarn/**'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/consistent-type-imports': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
			'no-console': 'off',
		},
	},
	{
		// The protocol package must stay pure: no I/O, so that it can be unit tested in isolation and
		// diffed against upstream. See docs/design.md §5.1.
		files: ['packages/protocol/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['node:net', 'node:http', 'node:https', 'node:fs', 'ws', 'express'],
							message: 'packages/protocol must stay free of I/O — see docs/design.md §5.1',
						},
					],
				},
			],
		},
	},
	{
		// No user-controlled egress anywhere in the server: the mock must never fetch a URL supplied
		// over the protocol (notably FIRMWARE-UPDATE-INFO's UPDATE_URL). See docs/design.md §9.1.
		files: ['packages/server/**/*.ts'],
		rules: {
			'no-restricted-globals': [
				'error',
				{ name: 'fetch', message: 'the server must make no outbound requests — see docs/design.md §9.1' },
			],
			// `node:http` itself is allowed — it is needed to create the server that express and the
			// WebSocket upgrade handler share. What is banned is anything that makes an outbound request.
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: 'axios',
							message: 'the server must make no outbound requests — see docs/design.md §9.1',
						},
						{
							name: 'node-fetch',
							message: 'the server must make no outbound requests — see docs/design.md §9.1',
						},
						{
							name: 'undici',
							message: 'the server must make no outbound requests — see docs/design.md §9.1',
						},
						{ name: 'got', message: 'the server must make no outbound requests — see docs/design.md §9.1' },
					],
				},
			],
		},
	}
)
