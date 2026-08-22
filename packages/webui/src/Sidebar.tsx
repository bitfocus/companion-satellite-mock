import { useEffect, useState } from 'react'
import type { SessionSnapshot } from './App.js'
import { trpc } from './trpc.js'
import { ChaosPanel, VersionPanel } from './ChaosPanel.js'

interface ScenarioInfo {
	id: string
	name: string
	description: string
	wants: readonly string[]
}

export function Sidebar({ session, onUnclaimed }: { session: SessionSnapshot; onUnclaimed: () => void }) {
	const [scenarios, setScenarios] = useState<ScenarioInfo[]>([])
	const [apiVersions, setApiVersions] = useState<readonly { version: string; companion: string | null }[]>([])
	const [raw, setRaw] = useState('')
	const [message, setMessage] = useState<string | null>(null)

	useEffect(() => {
		trpc.scenarios.query().then(setScenarios, () => setScenarios([]))
		trpc.server.query().then(
			(info) => setApiVersions(info.apiVersions),
			() => setApiVersions([])
		)
	}, [])

	const act = async (fn: () => Promise<unknown>, ok: string) => {
		try {
			await fn()
			setMessage(ok)
		} catch (caught) {
			setMessage(caught instanceof Error ? caught.message : 'Failed')
		}
	}

	return (
		<aside className="sidebar">
			<section className="card" data-testid="scenario-panel">
				<h2>Scenario</h2>
				<ul className="scenarios">
					{scenarios.map((scenario) => (
						<li key={scenario.id}>
							<button
								className={session.scenario?.id === scenario.id ? 'scenario active' : 'scenario'}
								onClick={() =>
									act(
										() =>
											trpc.selectScenario.mutate({
												sessionId: session.id,
												scenarioId: scenario.id,
											}),
										`Running ${scenario.name}`
									)
								}
							>
								<strong>{scenario.name}</strong>
								<span>{scenario.description}</span>
							</button>
						</li>
					))}
				</ul>
			</section>

			<section className="card" data-testid="device-panel">
				<h2>Device</h2>
				{session.device ? (
					<dl className="facts">
						<dt>Product</dt>
						<dd>{session.device.productName}</dd>
						<dt>Device id</dt>
						<dd>{session.device.id}</dd>
						<dt>Serial</dt>
						<dd>{session.device.serial}</dd>
						<dt>Grid</dt>
						<dd>
							{session.device.gridSize.columns}×{session.device.gridSize.rows}{' '}
							{session.device.fromManifest ? '(manifest)' : '(legacy)'}
						</dd>
						<dt>Bitmaps</dt>
						<dd>{session.device.bitmapFormat}</dd>
						<dt>Brightness</dt>
						<dd>{session.device.supportsBrightness ? 'supported' : 'opted out'}</dd>
						<dt>Pincode</dt>
						<dd>{session.device.supportsLockedState || 'not handled by client'}</dd>
						<dt>Page changes</dt>
						<dd>{session.device.canChangePage ?? 'not offered'}</dd>
						<dt>Keepalives</dt>
						<dd>
							{session.keepalives.in} in / {session.keepalives.out} out
							{session.keepalives.lastAt
								? ` · last ${Math.max(0, Math.round((Date.now() - session.keepalives.lastAt) / 100) / 10)}s ago`
								: ' · none yet'}
						</dd>
						<dt>Variables</dt>
						<dd>
							{session.device.variables.length === 0
								? 'none declared'
								: session.device.variables.map((v) => `${v.id} (${v.type})`).join(', ')}
						</dd>
					</dl>
				) : (
					<p className="muted">No device registered.</p>
				)}
			</section>

			<section className="card" data-testid="signals-panel">
				<h2>Received-only signals</h2>
				<p className="hint">
					These produce nothing on the wire but an <code>OK</code>, so this panel is the only place to confirm
					your client sent them.
				</p>
				<dl className="facts">
					<dt>Firmware update URL</dt>
					<dd>
						{session.device?.firmwareUpdateUrl ? (
							/* Deliberately inert text, never a link and never fetched — docs/design.md §9.1. */
							<code className="inert">{session.device.firmwareUpdateUrl}</code>
						) : (
							<span className="muted">none reported</span>
						)}
					</dd>
				</dl>
			</section>

			<section className="card" data-testid="raw-panel">
				<h2>Send a raw line</h2>
				<form
					onSubmit={(event) => {
						event.preventDefault()
						void act(() => trpc.sendRaw.mutate({ sessionId: session.id, line: raw }), 'Sent')
						setRaw('')
					}}
				>
					<input
						value={raw}
						onChange={(event) => setRaw(event.target.value)}
						placeholder='KEYS-CLEAR DEVICEID="dev1"'
						spellCheck={false}
						aria-label="Raw protocol line"
					/>
					<button type="submit" disabled={raw.length === 0}>
						Send
					</button>
				</form>
				<p className="hint">Quotes and newlines are refused: they would corrupt the line.</p>
			</section>

			<ChaosPanel sessionId={session.id} connected={session.connected} />

			<VersionPanel apiVersions={apiVersions} />

			<section className="card" data-testid="connection-panel">
				<h2>Connection</h2>
				<div className="toolbar">
					<button
						onClick={() => act(() => trpc.disconnect.mutate({ sessionId: session.id }), 'Disconnected')}
					>
						Force disconnect
					</button>
					<button
						onClick={() =>
							act(async () => {
								await trpc.unclaim.mutate({ sessionId: session.id })
								onUnclaimed()
							}, 'Unclaimed')
						}
					>
						Unclaim
					</button>
				</div>
				<p className="hint">Unclaiming returns the surface to the Unclaimed scenario and mints a fresh code.</p>
			</section>

			{message && (
				<p className="toast" data-testid="toast">
					{message}
				</p>
			)}
		</aside>
	)
}
