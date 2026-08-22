import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './style.css'

const element = document.getElementById('root')
if (!element) throw new Error('missing #root')

createRoot(element).render(
	<StrictMode>
		<App />
	</StrictMode>
)
