import { useEffect, useState } from 'react'
import type { SessionSnapshot } from './App.js'
import { trpc } from './trpc.js'
import { useAction } from './useAction.js'

interface ScenarioInfo {
	id: string
	name: string
	description: string
	wants: readonly string[]
}

export function ScenarioPanel({ session }: { session: SessionSnapshot }) {
	const [scenarios, setScenarios] = useState<ScenarioInfo[]>([])
	const [act, message] = useAction()

	useEffect(() => {
		trpc.scenarios.query().then(setScenarios, () => setScenarios([]))
	}, [])

	return (
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
										trpc.selectScenario.mutate({ sessionId: session.id, scenarioId: scenario.id }),
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
			{message && <p className="hint">{message}</p>}
		</section>
	)
}
