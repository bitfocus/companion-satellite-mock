import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Placeholder. Phase 7 builds the real UI.
function App() {
	return <h1>Satellite Mock</h1>
}

const el = document.getElementById('root')
if (!el) throw new Error('missing #root')
createRoot(el).render(
	<StrictMode>
		<App />
	</StrictMode>
)
