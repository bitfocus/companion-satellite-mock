import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{
		// `packages/protocol/src/upstream` is copied verbatim from Companion. Linting it would invite
		// edits, and the whole value of those files is that a refresh is a clean diff. See docs/upstream.md.
		ignores: [
			'**/dist/**',
			'**/node_modules/**',
			'**/coverage/**',
			'.yarn/**',
			'packages/protocol/src/upstream/**',
		],
	},
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
		//
		// Tests are exempt: they are excluded from the build by the package's tsconfig, so they are
		// not part of the shipped artifact, and the conformance corpus has to be read from disk.
		// The invariant is about what gets built, not about what exercises it.
		files: ['packages/protocol/**/*.ts'],
		ignores: ['packages/protocol/**/*.test.ts'],
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
		//
		// Tests are exempt on the same grounds as the protocol package's rule: they are excluded from
		// the build, so they are not part of the shipped artifact, and they legitimately need to make
		// requests *to our own listener* to check it behaves.
		files: ['packages/server/**/*.ts'],
		ignores: ['packages/server/**/*.test.ts'],
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
