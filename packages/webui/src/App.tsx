import { useCallback, useEffect, useMemo, useState } from 'react'
import { trpc } from './trpc.js'
import { SurfaceMirror } from './SurfaceMirror.js'
import { TracePanel } from './TracePanel.js'
import { Sidebar } from './Sidebar.js'
import type { ConfigField } from './DeviceConfigPanel.js'

export interface ControlTile {
	id: string
	row: number
	column: number
	preview: string
	style: {
		bgColor: string
		textColor: string
		text: string
		fontSize: number | 'auto'
		pressed: boolean
		type: string
	}
	wants: {
		bitmap: { w: number; h: number } | null
		colors: string | null
		text: boolean
		textStyle: boolean
		leds: { segments: number; mode: string } | null
	}
}

export interface SessionSnapshot {
	id: string
	state: 'unclaimed' | 'claimed' | 'offline'
	claimCode: string
	createdAt: number
	connected: boolean
	apiVersion: string | null
	device: {
		id: string
		serial: string
		productName: string
		gridSize: { rows: number; columns: number }
		fromManifest: boolean
		bitmapFormat: string
		supportsBrightness: boolean
		supportsLockedState: false | 'FULL' | 'PARTIAL'
		canChangePage: string | null
		variables: { id: string; type: string; name: string; description?: string }[]
		configFields: readonly ConfigField[] | null
		configValues: Record<string, string | number | boolean>
		firmwareUpdateUrl: string | null
		controls: { id: string; row: number; column: number }[]
	} | null
	scenario: { id: string; name: string } | null
	keepalives: { in: number; out: number; lastAt: number | null }
}

export interface TraceEntry {
	at: number
	direction: 'in' | 'out'
	line: string
}

const SESSION_KEY = 'satellite-mock:session-id'

export function App() {
	const [sessionId, setSessionId] = useState<string | null>(() => {
		try {
			return localStorage.getItem(SESSION_KEY)
		} catch {
			return null
		}
	})

	const select = useCallback((id: string | null) => {
		setSessionId(id)
		try {
			if (id) localStorage.setItem(SESSION_KEY, id)
			else localStorage.removeItem(SESSION_KEY)
		} catch {
			// Storage unavailable; the session is still usable for this page load.
		}
	}, [])

	return sessionId ? (
		<SessionView sessionId={sessionId} onLeave={() => select(null)} />
	) : (
		<ClaimView onClaimed={select} />
	)
}

function ClaimView({ onClaimed }: { onClaimed: (id: string) => void }) {
	const [code, setCode] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const wsUrl = useMemo(() => {
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
		// The satellite listener is a different port from the UI. In production the reverse proxy
		// maps it onto the same host, which is why this is the address shown rather than the internal one.
		return `${protocol}//${location.hostname}/ws/satellite`
	}, [])

	const submit = async (event: React.FormEvent) => {
		event.preventDefault()
		setBusy(true)
		setError(null)
		try {
			const result = await trpc.claim.mutate({ code })
			onClaimed(result.sessionId)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : 'Could not claim that code')
		} finally {
			setBusy(false)
		}
	}

	return (
		<main className="claim">
			<h1>Satellite Mock</h1>
			<p className="lede">
				A test server speaking Bitfocus Companion&rsquo;s Satellite API. Point a client at it and the surface
				comes to life immediately &mdash; no setup, no account.
			</p>

			<section className="card">
				<h2>1. Connect your client</h2>
				<code className="url">{wsUrl}</code>
				<p className="hint">Also reachable on port 16623 directly, if you are not behind the proxy.</p>
			</section>

			<section className="card">
				<h2>2. Read the code off the surface</h2>
				<p>
					Your surface will show <strong>UNCLAIMED</strong> and a six-character code. Type it here to take
					control. There is nothing to copy out of the app.
				</p>
				<form onSubmit={submit}>
					<input
						value={code}
						onChange={(event) => setCode(event.target.value)}
						placeholder="K7M-2QP"
						autoFocus
						spellCheck={false}
						aria-label="Claim code"
					/>
					<button type="submit" disabled={busy || code.length < 3}>
						{busy ? 'Claiming…' : 'Claim'}
					</button>
				</form>
				{error && <p className="error">{error}</p>}
			</section>
		</main>
	)
}

function SessionView({ sessionId, onLeave }: { sessionId: string; onLeave: () => void }) {
	const [session, setSession] = useState<SessionSnapshot | null>(null)
	const [tiles, setTiles] = useState<ControlTile[]>([])
	const [trace, setTrace] = useState<TraceEntry[]>([])
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const subscriptions = [
			trpc.watchSession.subscribe(
				{ sessionId },
				{
					onData: (data) => setSession(data as SessionSnapshot | null),
					onError: (caught) => setError(caught.message),
				}
			),
			trpc.watchSurface.subscribe(
				{ sessionId },
				{ onData: (data) => setTiles(data as ControlTile[]), onError: (caught) => setError(caught.message) }
			),
			trpc.watchTrace.subscribe(
				{ sessionId },
				{
					// Bounded in the UI as well as on the server: a long-running session would otherwise
					// grow this array without limit in the browser.
					onData: (entries) => setTrace((current) => [...current, ...(entries as TraceEntry[])].slice(-500)),
					onError: (caught) => setError(caught.message),
				}
			),
		]
		return () => subscriptions.forEach((subscription) => subscription.unsubscribe())
	}, [sessionId])

	if (error) {
		return (
			<main className="claim">
				<h1>Session unavailable</h1>
				<p className="error">{error}</p>
				<button onClick={onLeave}>Back</button>
			</main>
		)
	}

	if (!session) return <main className="claim">Connecting…</main>

	return (
		<div className="session">
			<header>
				<div>
					<strong>{session.device?.productName ?? 'No device'}</strong>
					<span className={`badge ${session.connected ? 'ok' : 'warn'}`}>
						{session.connected ? 'connected' : 'offline'}
					</span>
					{session.device && <span className="muted">{session.device.id}</span>}
					{session.apiVersion && <span className="muted">API {session.apiVersion}</span>}
				</div>
				<button onClick={onLeave}>Leave</button>
			</header>

			<div className="layout">
				<div className="main">
					<SurfaceMirror tiles={tiles} gridSize={session.device?.gridSize ?? { rows: 0, columns: 0 }} />
					<TracePanel entries={trace} />
				</div>
				<Sidebar session={session} onUnclaimed={onLeave} />
			</div>
		</div>
	)
}
