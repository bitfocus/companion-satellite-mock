import { trpc } from './trpc.js'
import { useAction } from './useAction.js'

export function ConnectionPanel({ sessionId, onUnclaimed }: { sessionId: string; onUnclaimed: () => void }) {
	const [act, message] = useAction()

	return (
		<section className="card" data-testid="connection-panel">
			<h2>Claim</h2>
			<div className="toolbar">
				<button
					onClick={() =>
						act(async () => {
							await trpc.unclaim.mutate({ sessionId })
							onUnclaimed()
						}, 'Unclaimed')
					}
				>
					Unclaim
				</button>
			</div>
			<p className="hint">Unclaiming returns the surface to the Unclaimed scenario and mints a fresh code.</p>
			{message && <p className="hint">{message}</p>}
		</section>
	)
}
