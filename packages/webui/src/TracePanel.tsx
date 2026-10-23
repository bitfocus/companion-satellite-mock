import { useMemo, useState } from 'react'
import type { TraceEntry } from './App.js'

/**
 * The protocol trace.
 *
 * Bitmap payloads are elided server-side — a trace with 20KB of base64 per line is unusable, and
 * nobody reads a bitmap as text. Keepalives never reach the trace at all: at 10Hz they would evict
 * every useful line from the ring buffer within seconds, so they are counted instead and shown on
 * the Device tab.
 */
export function TracePanel({ entries }: { entries: TraceEntry[] }) {
	const [filter, setFilter] = useState('')
	const [paused, setPaused] = useState(false)
	const [frozen, setFrozen] = useState<TraceEntry[]>([])
	// Hidden by default. The reference client pings at 10Hz, so PING/PONG is 20 lines a second and
	// buries everything worth reading — the first look at a real trace was nothing else.
	const shown = useMemo(() => {
		const source = paused ? frozen : entries
		const needle = filter.trim().toUpperCase()
		const filtered = needle ? source.filter((entry) => entry.line.toUpperCase().includes(needle)) : source
		return filtered.slice(-200)
	}, [entries, filter, paused, frozen])

	const togglePause = () => {
		if (!paused) setFrozen(entries)
		setPaused(!paused)
	}

	return (
		<section className="card" data-testid="trace-panel">
			<h2>
				Protocol trace <span className="muted">{entries.length} lines</span>
			</h2>
			<div className="toolbar">
				<input
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
					placeholder="filter, e.g. KEY-PRESS"
					aria-label="Filter trace"
				/>
				<button onClick={togglePause}>{paused ? 'Resume' : 'Pause'}</button>
				<button
					onClick={() => {
						void navigator.clipboard?.writeText(shown.map((entry) => entry.line).join('\n'))
					}}
				>
					Copy
				</button>
			</div>
			<ol className="trace">
				{shown.map((entry, index) => (
					<li key={`${entry.at}-${index}`} className={entry.direction}>
						<span className="dir">{entry.direction === 'in' ? '→' : '←'}</span>
						<code>{entry.line}</code>
					</li>
				))}
			</ol>
			{shown.length === 0 && <p className="muted">Nothing yet.</p>}
		</section>
	)
}
