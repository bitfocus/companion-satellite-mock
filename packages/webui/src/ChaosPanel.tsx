import { useEffect, useState } from 'react'
import { trpc } from './trpc.js'

export interface ChaosConfig {
	latencyMs: number
	jitterMs: number
	dropRate: number
	duplicateRate: number
	splitFrames: number
	coalesceMs: number
	swallowPings: boolean
	trailingSpace: boolean
	crlf: boolean
}

const DEFAULTS: ChaosConfig = {
	latencyMs: 0,
	jitterMs: 0,
	dropRate: 0,
	duplicateRate: 0,
	splitFrames: 0,
	coalesceMs: 0,
	swallowPings: false,
	trailingSpace: true,
	crlf: false,
}

/** Ceilings mirror the server's schema; the server validates regardless. */
const SLIDERS: { key: keyof ChaosConfig; label: string; max: number; step: number; hint?: string }[] = [
	{ key: 'latencyMs', label: 'Latency (ms)', max: 2000, step: 50 },
	{ key: 'jitterMs', label: 'Jitter (ms)', max: 2000, step: 50 },
	{ key: 'dropRate', label: 'Drop rate', max: 1, step: 0.05 },
	{ key: 'duplicateRate', label: 'Duplicate rate', max: 1, step: 0.05 },
	{
		key: 'splitFrames',
		label: 'Split into frames',
		max: 64,
		step: 1,
		hint: 'Splits each line across N WebSocket frames. A client that assumes one frame is one message fails here — and passes every ordinary test.',
	},
	{ key: 'coalesceMs', label: 'Coalesce (ms)', max: 2000, step: 50, hint: 'Batch lines into one frame.' },
]

export function ChaosPanel({ sessionId, connected }: { sessionId: string; connected: boolean }) {
	const [config, setConfig] = useState<ChaosConfig>(DEFAULTS)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		trpc.chaos.query({ sessionId }).then(
			(loaded) => setConfig(loaded as ChaosConfig),
			() => setConfig(DEFAULTS)
		)
	}, [sessionId])

	const apply = (next: ChaosConfig) => {
		setConfig(next)
		trpc.setChaos.mutate({ sessionId, config: next }).then(
			() => setError(null),
			(caught: unknown) => setError(caught instanceof Error ? caught.message : 'Failed')
		)
	}

	return (
		<section className="card">
			<h2>Fault injection</h2>
			{!connected && <p className="hint">Client is offline; settings apply when it reconnects.</p>}

			{SLIDERS.map((slider) => (
				<label key={slider.key} className="slider">
					<span>
						{slider.label}
						<em>{config[slider.key] as number}</em>
					</span>
					<input
						type="range"
						min={0}
						max={slider.max}
						step={slider.step}
						value={config[slider.key] as number}
						onChange={(event) => apply({ ...config, [slider.key]: Number(event.target.value) })}
					/>
					{slider.hint && <small>{slider.hint}</small>}
				</label>
			))}

			<label className="check">
				<input
					type="checkbox"
					checked={config.swallowPings}
					onChange={(event) => apply({ ...config, swallowPings: event.target.checked })}
				/>
				Stop answering PING
			</label>
			<label className="check">
				<input
					type="checkbox"
					checked={!config.trailingSpace}
					onChange={(event) => apply({ ...config, trailingSpace: !event.target.checked })}
				/>
				Drop Companion&rsquo;s trailing space
			</label>
			<label className="check">
				<input
					type="checkbox"
					checked={config.crlf}
					onChange={(event) => apply({ ...config, crlf: event.target.checked })}
				/>
				Terminate lines with CRLF
			</label>

			<div className="toolbar">
				<button onClick={() => apply(DEFAULTS)}>Reset all</button>
			</div>
			{error && <p className="error">{error}</p>}
			<p className="hint">Every knob is capped server-side and applies only to this session.</p>
		</section>
	)
}

/** Builds the URL that selects an older server, since the version is fixed when the socket opens. */
export function VersionPanel({
	apiVersions,
}: {
	apiVersions: readonly { version: string; companion: string | null }[]
}) {
	const [version, setVersion] = useState('')
	const [subs, setSubs] = useState(true)
	const [formats, setFormats] = useState('')

	const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
	const params = new URLSearchParams()
	if (version) params.set('api', version)
	if (!subs) params.set('subs', '0')
	if (formats) params.set('formats', formats)
	const query = params.toString()
	const url = `${protocol}//${location.hostname}/ws/satellite${query ? `?${query}` : ''}`

	return (
		<section className="card">
			<h2>Protocol version</h2>
			<p className="hint">
				The version is fixed when the socket opens &mdash; <code>BEGIN</code> is sent before any{' '}
				<code>ADD-DEVICE</code>, so the server has no device identity to key an override on. Point your client
				at this URL instead.
			</p>

			<label className="field">
				<span>API version</span>
				<select value={version} onChange={(event) => setVersion(event.target.value)}>
					<option value="">Latest (1.14.0)</option>
					{apiVersions.map((entry) => (
						<option key={entry.version} value={entry.version}>
							{entry.version}
							{entry.companion ? ` — Companion ${entry.companion}` : ''}
						</option>
					))}
				</select>
			</label>

			<label className="field">
				<span>Bitmap formats</span>
				<select value={formats} onChange={(event) => setFormats(event.target.value)}>
					<option value="">All the version supports</option>
					<option value="rgb">rgb only</option>
					<option value="rgb,png">rgb and png</option>
				</select>
			</label>

			<label className="check">
				<input type="checkbox" checked={subs} onChange={(event) => setSubs(event.target.checked)} />
				Subscriptions enabled
			</label>

			<code className="url">{url}</code>
			<div className="toolbar">
				<button onClick={() => void navigator.clipboard?.writeText(url)}>Copy URL</button>
			</div>
		</section>
	)
}
