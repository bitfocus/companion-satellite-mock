import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import type { AppRouter } from '@satellite-mock/server/dist/web/trpc.js'

/**
 * A stable per-browser id.
 *
 * Not a credential: it scopes which sessions this tab may act on, and holding someone else's would
 * gain nothing they could not get with the claim code anyway. It exists so a claim survives a
 * refresh, and so two tabs on one machine do not fight.
 */
function uiClientId(): string {
	const KEY = 'satellite-mock:client-id'
	try {
		const existing = localStorage.getItem(KEY)
		if (existing) return existing
		const created = crypto.randomUUID()
		localStorage.setItem(KEY, created)
		return created
	} catch {
		// Private browsing, or storage disabled. A per-load id still works; the claim just will not
		// survive a refresh.
		return crypto.randomUUID()
	}
}

const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
const wsClient = createWSClient({
	url: `${protocol}//${location.host}/ws/trpc?client=${encodeURIComponent(uiClientId())}`,
})

export const trpc = createTRPCClient<AppRouter>({ links: [wsLink({ client: wsClient })] })
export type { AppRouter }
