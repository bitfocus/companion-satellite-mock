import { useCallback, useEffect, useState } from 'react'
import { trpc } from './trpc.js'

/** Codes a server may legitimately send, with what a client is supposed to make of each. */
const CLOSE_CODES = [
	{ code: 0, label: 'No code (hard terminate)', hint: 'What the server does on its own error paths.' },
	{ code: 1000, label: '1000 Normal closure', hint: 'A clean, expected close.' },
	{ code: 1001, label: '1001 Going away', hint: 'Server restarting. Reconnect promptly.' },
	{ code: 1008, label: '1008 Policy violation', hint: 'Do not just retry — something is wrong.' },
	{ code: 1011, label: '1011 Internal error', hint: 'Server-side fault. Back off and retry.' },
	{ code: 1013, label: '1013 Try again later', hint: 'Overloaded. Back off properly.' },
] as const

/**
 * Force-disconnect with a chosen status code, and optionally refuse the client back for a while.
 *
 * These two together are the reconnect test. A plain disconnect only proves the client noticed;
 * what breaks in the field is what it does next, and that is invisible unless the server stays
 * unreachable long enough for the backoff to show itself.
 */
export function ReconnectPanel({ sessionId, connected }: { sessionId: string; connected: boolean }) {
	const [code, setCode] = useState(1001)
	const [blackoutSec, setBlackoutSec] = useState(10)
	const [remainingMs, setRemainingMs] = useState(0)
	const [maxMs, setMaxMs] = useState(60_000)
	const [message, setMessage] = useState<string | null>(null)

	const refresh = useCallback(() => {
		trpc.blackout.query({ sessionId }).then(
			(state) => {
				setRemainingMs(state.remainingMs)
				setMaxMs(state.maxMs)
			},
			() => setRemainingMs(0)
		)
	}, [sessionId])

	useEffect(() => {
		refresh()
		// Ticks once a second so the countdown is a countdown rather than a stale number.
		const timer = setInterval(refresh, 1000)
		return () => clearInterval(timer)
	}, [refresh])

	const disconnect = () => {
		trpc.disconnect
			.mutate({
				sessionId,
				...(code > 0 ? { code: code as 1000 | 1001 | 1008 | 1011 | 1013 } : {}),
				blackoutMs: blackoutSec * 1000,
			})
			.then(
				() => {
					setMessage(
						blackoutSec > 0 ? `Disconnected, refusing reconnects for ${blackoutSec}s` : 'Disconnected'
					)
					refresh()
				},
				(caught: unknown) => setMessage(caught instanceof Error ? caught.message : 'Failed')
			)
	}

	const clear = () => {
		trpc.clearBlackout.mutate({ sessionId }).then(
			() => {
				setMessage('Blackout cleared')
				refresh()
			},
			(caught: unknown) => setMessage(caught instanceof Error ? caught.message : 'Failed')
		)
	}

	const selected = CLOSE_CODES.find((entry) => entry.code === code)
	const maxSec = Math.floor(maxMs / 1000)

	return (
		<section className="card" data-testid="reconnect-panel">
			<h2>Disconnect &amp; reconnect</h2>

			<label className="field">
				<span>Close code</span>
				<select value={code} data-testid="close-code" onChange={(event) => setCode(Number(event.target.value))}>
					{CLOSE_CODES.map((entry) => (
						<option key={entry.code} value={entry.code}>
							{entry.label}
						</option>
					))}
				</select>
				{selected && <small>{selected.hint}</small>}
			</label>

			<label className="field">
				<span>Then refuse reconnects for</span>
				<input
					type="number"
					min={0}
					max={maxSec}
					value={blackoutSec}
					data-testid="blackout-seconds"
					onChange={(event) => setBlackoutSec(Math.max(0, Math.min(maxSec, Number(event.target.value) || 0)))}
				/>
				<small>Seconds, 0 for none. Capped at {maxSec}s, and it only ever applies to your client.</small>
			</label>

			<div className="toolbar">
				<button onClick={disconnect} disabled={!connected} data-testid="disconnect-with-code">
					Force disconnect
				</button>
				<button onClick={clear} disabled={remainingMs === 0} data-testid="clear-blackout">
					Clear blackout
				</button>
			</div>

			{remainingMs > 0 && (
				<p className="hint" data-testid="blackout-status">
					Refusing reconnects for another {Math.ceil(remainingMs / 1000)}s.
				</p>
			)}
			{message && <p className="hint">{message}</p>}
		</section>
	)
}
