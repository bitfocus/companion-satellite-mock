import { useCallback, useEffect, useMemo, useState } from 'react'
import { trpc } from './trpc.js'
import { SurfaceMirror } from './SurfaceMirror.js'
import { TracePanel } from './TracePanel.js'
import { ScenarioPanel } from './ScenarioPanel.js'
import { SubscriptionsPanel } from './SubscriptionsPanel.js'
import { RawPanel } from './RawPanel.js'
import { ChaosPanel, VersionPanel } from './ChaosPanel.js'
import { ReconnectPanel } from './ReconnectPanel.js'
import { ConnectionPanel } from './ConnectionPanel.js'
import { DeviceInfoPanel, SignalsPanel } from './DeviceInfoPanel.js'
import { DeviceConfigPanel } from './DeviceConfigPanel.js'
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
	const [tab, selectTab] = useTab()
	// Lines received in total and as of the last look at the Log tab, for its unread count. Counted
	// separately from `trace`, which is capped and so stops growing.
	const [traceTotal, setTraceTotal] = useState(0)
	const [traceSeen, setTraceSeen] = useState(0)
	useEffect(() => {
		if (tab === 'log') setTraceSeen(traceTotal)
	}, [tab, traceTotal])

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
					onData: (entries) => {
						setTrace((current) => [...current, ...(entries as TraceEntry[])].slice(-500))
						setTraceTotal((total) => total + (entries as TraceEntry[]).length)
					},
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
			<div className="session-top">
				<header className="session-header">
					<div className="session-title">
						<strong>{session.device?.productName ?? 'No device'}</strong>
						<span className={`badge ${session.connected ? 'ok' : 'warn'}`}>
							{session.connected ? 'connected' : 'offline'}
						</span>
						{session.device && <span className="muted">{session.device.id}</span>}
						{session.apiVersion && <span className="muted">API {session.apiVersion}</span>}
					</div>
					<button className="secondary" onClick={onLeave}>
						Leave
					</button>
				</header>

				<TabBar tab={tab} onSelect={selectTab} unreadLog={traceTotal - traceSeen} />
			</div>

			<TabPanel id="surface" tab={tab}>
				<div className="split">
					<SurfaceMirror tiles={tiles} gridSize={session.device?.gridSize ?? { rows: 0, columns: 0 }} />
					<ScenarioPanel session={session} />
				</div>
			</TabPanel>

			<TabPanel id="subscriptions" tab={tab}>
				<div className="narrow">
					<SubscriptionsPanel sessionId={session.id} />
				</div>
			</TabPanel>

			<TabPanel id="log" tab={tab}>
				<div className="stack">
					<RawPanel sessionId={session.id} />
					<TracePanel entries={trace} />
				</div>
			</TabPanel>

			<TabPanel id="network" tab={tab}>
				<div className="cards">
					<ReconnectPanel sessionId={session.id} connected={session.connected} />
					<ChaosPanel sessionId={session.id} connected={session.connected} />
					<VersionPanel />
					<ConnectionPanel sessionId={session.id} onUnclaimed={onLeave} />
				</div>
			</TabPanel>

			<TabPanel id="device" tab={tab}>
				<div className="cards">
					<DeviceInfoPanel session={session} />
					<DeviceConfigPanel
						sessionId={session.id}
						fields={session.device?.configFields ?? null}
						values={session.device?.configValues ?? {}}
					/>
					<SignalsPanel session={session} />
				</div>
			</TabPanel>
		</div>
	)
}

const TABS = [
	{ id: 'surface', label: 'Surface' },
	// Its own tab, not part of Surface: subscriptions watch Companion page locations, not this
	// surface's controls, and no scenario drives them.
	{ id: 'subscriptions', label: 'Subscriptions' },
	{ id: 'log', label: 'Log' },
	{ id: 'network', label: 'Network' },
	{ id: 'device', label: 'Device' },
] as const

type TabId = (typeof TABS)[number]['id']

const tabFromHash = (): TabId => TABS.find((entry) => `#${entry.id}` === location.hash)?.id ?? 'surface'

/** The selected tab, kept in the URL hash so a reload or a shared link lands on the same one. */
function useTab(): [TabId, (tab: TabId) => void] {
	const [tab, setTab] = useState<TabId>(tabFromHash)

	useEffect(() => {
		const onHashChange = () => setTab(tabFromHash())
		window.addEventListener('hashchange', onHashChange)
		return () => window.removeEventListener('hashchange', onHashChange)
	}, [])

	const select = useCallback((next: TabId) => {
		setTab(next)
		history.replaceState(null, '', next === 'surface' ? location.pathname + location.search : `#${next}`)
	}, [])

	return [tab, select]
}

function TabBar({ tab, onSelect, unreadLog }: { tab: TabId; onSelect: (tab: TabId) => void; unreadLog: number }) {
	// Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects; Tab moves into the panel.
	const onKeyDown = (event: React.KeyboardEvent) => {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
		if (!step) return
		const index = TABS.findIndex((entry) => entry.id === tab)
		const next = TABS[(index + step + TABS.length) % TABS.length]!
		onSelect(next.id)
		document.getElementById(`tab-${next.id}`)?.focus()
	}

	return (
		<nav className="tabs" role="tablist" aria-label="Session" onKeyDown={onKeyDown}>
			{TABS.map((entry) => (
				<button
					key={entry.id}
					id={`tab-${entry.id}`}
					role="tab"
					aria-selected={tab === entry.id}
					aria-controls={`panel-${entry.id}`}
					tabIndex={tab === entry.id ? 0 : -1}
					className="tab"
					onClick={() => onSelect(entry.id)}
				>
					{entry.label}
					{entry.id === 'log' && unreadLog > 0 && (
						<span className="count" aria-label={`${unreadLog} new lines`}>
							{unreadLog > 99 ? '99+' : unreadLog}
						</span>
					)}
				</button>
			))}
		</nav>
	)
}

/**
 * Hidden rather than unmounted, so a tab keeps its state — a paused trace, a half-typed raw line —
 * while another one is open.
 */
function TabPanel({ id, tab, children }: { id: TabId; tab: TabId; children: React.ReactNode }) {
	return (
		<section
			id={`panel-${id}`}
			role="tabpanel"
			aria-labelledby={`tab-${id}`}
			hidden={tab !== id}
			className="tab-panel"
		>
			{children}
		</section>
	)
}
