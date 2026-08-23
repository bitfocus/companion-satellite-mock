import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Dockerfile's workspace manifest list has to stay complete.
 *
 * The root `workspaces` glob is `packages/*`, so yarn resolves whatever manifests it can see. The
 * Dockerfile copies them one by one to get a cacheable dependency layer before the source — and
 * when a new package was added and that list was not updated, yarn inside the image resolved a
 * smaller project than the lockfile describes and `--immutable` refused the resulting change.
 *
 * That failure is invisible everywhere else: `yarn install` on a full checkout is fine, so lint,
 * typecheck and the whole test suite pass while only the image build breaks. Hence a test, checking
 * the one thing that actually drifts.
 */

const root = new URL('../../../', import.meta.url)
const dockerfile = readFileSync(fileURLToPath(new URL('Dockerfile', root)), 'utf8')

const workspaces = readdirSync(fileURLToPath(new URL('packages', root)), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort()

/** Each `RUN ... yarn install`/`yarn workspaces focus` and the COPY lines that precede it. */
function installStages(): { command: string; copied: string[] }[] {
	const stages: { command: string; copied: string[] }[] = []
	let copied: string[] = []

	for (const line of dockerfile.split('\n')) {
		const copy = /^COPY\s+packages\/([^/]+)\/package\.json/.exec(line.trim())
		if (copy?.[1]) copied.push(copy[1])

		if (/^RUN\s+node\s+\$YARN\s+(install|workspaces focus)/.test(line.trim())) {
			stages.push({ command: line.trim(), copied })
			copied = []
		}
	}
	return stages
}

describe('Dockerfile', () => {
	it('has an install stage to check at all', () => {
		// Guards the test itself: a Dockerfile restructured past the parser above would otherwise
		// pass vacuously, which is worse than failing.
		expect(installStages().length).toBeGreaterThanOrEqual(2)
	})

	it('copies every workspace manifest before each install', () => {
		expect(workspaces.length).toBeGreaterThan(1)

		for (const stage of installStages()) {
			expect([...stage.copied].sort(), `missing manifests before: ${stage.command}`).toEqual(workspaces)
		}
	})

	it('skips the playwright browser download, which nothing in the image runs', () => {
		// The e2e manifest is present only to satisfy the resolver; without this its install script
		// pulls a browser into a layer that will never launch one.
		expect(dockerfile).toContain('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1')
	})
})
