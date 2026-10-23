import type { SessionSnapshot } from './App.js'

/** What the client registered, as the server understood it. */
export function DeviceInfoPanel({ session }: { session: SessionSnapshot }) {
	return (
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
	)
}

/** Messages that produce nothing on the wire but an OK, so this is the only place to see them arrived. */
export function SignalsPanel({ session }: { session: SessionSnapshot }) {
	return (
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
						/* Deliberately inert text, never a link and never fetched — docs/security.md. */
						<code className="inert">{session.device.firmwareUpdateUrl}</code>
					) : (
						<span className="muted">none reported</span>
					)}
				</dd>
			</dl>
		</section>
	)
}
