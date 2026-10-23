import { useState } from 'react'
import { trpc } from './trpc.js'
import { useAction } from './useAction.js'

export function RawPanel({ sessionId }: { sessionId: string }) {
	const [raw, setRaw] = useState('')
	const [act, message] = useAction()

	return (
		<section className="card" data-testid="raw-panel">
			<h2>Send a raw line</h2>
			<form
				onSubmit={(event) => {
					event.preventDefault()
					void act(() => trpc.sendRaw.mutate({ sessionId, line: raw }), 'Sent')
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
			<p className="hint">
				Quotes and newlines are refused: they would corrupt the line.
				{message && (
					<>
						{' '}
						<span className="toast" data-testid="toast">
							{message}
						</span>
					</>
				)}
			</p>
		</section>
	)
}
