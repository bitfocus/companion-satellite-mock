import { useCallback, useEffect, useState } from 'react'
import { trpc } from './trpc.js'

interface SubscriptionRow {
	subId: string
	location: string
	bitmapFormat: string
	wants: { bitmap: { w: number; h: number } | null; colors: string | null; text: boolean; textStyle: boolean }
	content: { bgColor: string; textColor: string; text: string }
}

/**
 * Subscriptions the client has registered, and the content of the locations they watch.
 *
 * Subscriptions reference an absolute `page/row/column` rather than a surface, so there is no
 * scenario driving them — editing a location here pushes `SUB-STATE` to everyone watching it.
 */
export function SubscriptionsPanel({ sessionId }: { sessionId: string }) {
	const [rows, setRows] = useState<SubscriptionRow[]>([])
	const [text, setText] = useState('')
	const [bgColor, setBgColor] = useState('#204080')
	const [target, setTarget] = useState('')
	const [message, setMessage] = useState<string | null>(null)

	const refresh = useCallback(() => {
		trpc.subscriptions.query({ sessionId }).then(
			(loaded) => setRows(loaded as SubscriptionRow[]),
			() => setRows([])
		)
	}, [sessionId])

	useEffect(() => {
		refresh()
		// Polled rather than subscribed: this changes only when the client registers a subscription,
		// which is rare, and a dedicated stream for it would be more machinery than it is worth.
		const timer = setInterval(refresh, 2000)
		return () => clearInterval(timer)
	}, [refresh])

	const push = () => {
		const location = target || rows[0]?.location
		if (!location) return

		trpc.setPageContent.mutate({ sessionId, location, text, bgColor, textColor: '#ffffff' }).then(
			(result) => {
				setMessage(`Pushed to ${result.notified} subscription${result.notified === 1 ? '' : 's'}`)
				refresh()
			},
			(caught: unknown) => setMessage(caught instanceof Error ? caught.message : 'Failed')
		)
	}

	return (
		<section className="card" data-testid="subscriptions-panel">
			<h2>Subscriptions</h2>

			{rows.length === 0 ? (
				<p className="hint">
					This client has no subscriptions. If it sends <code>ADD-SUB</code>, they appear here and you can
					edit what each watched location shows.
				</p>
			) : (
				<>
					<ul className="subs" data-testid="subscription-list">
						{rows.map((row) => (
							<li key={row.subId}>
								<button
									className={target === row.location ? 'scenario active' : 'scenario'}
									onClick={() => setTarget(row.location)}
								>
									<strong>{row.subId}</strong>
									<span>
										{row.location} · wants{' '}
										{[
											row.wants.bitmap && `bitmap ${row.wants.bitmap.w}×${row.wants.bitmap.h}`,
											row.wants.colors && `colours (${row.wants.colors})`,
											row.wants.text && 'text',
										]
											.filter(Boolean)
											.join(', ') || 'nothing'}
									</span>
								</button>
							</li>
						))}
					</ul>

					<label className="field">
						<span>Location</span>
						<input
							value={target || rows[0]?.location || ''}
							onChange={(event) => setTarget(event.target.value)}
							placeholder="1/2/3"
							aria-label="Subscription location"
						/>
					</label>
					<label className="field">
						<span>Text</span>
						<input
							value={text}
							onChange={(event) => setText(event.target.value)}
							aria-label="Subscription text"
						/>
					</label>
					<label className="field">
						<span>Background</span>
						<input
							type="color"
							value={bgColor}
							onChange={(event) => setBgColor(event.target.value)}
							aria-label="Subscription background"
						/>
					</label>

					<div className="toolbar">
						<button onClick={push}>Push to location</button>
					</div>
					{message && <p className="hint">{message}</p>}
				</>
			)}
		</section>
	)
}
