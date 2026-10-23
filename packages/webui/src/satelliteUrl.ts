/** The satellite listener's port when it is reached directly rather than through the proxy. */
const DIRECT_SATELLITE_PORT = 16623

/**
 * Where a satellite client should connect, worked out from how this page was loaded.
 *
 * Behind the reverse proxy the page is on the standard port and the proxy routes /ws/satellite on
 * the same host, over TLS. Loaded with an explicit port, there is no proxy: the satellite listener
 * is its own port on the same host. Showing the proxy form there sent people to a URL nothing
 * answered.
 */
export function satelliteUrl(query = ''): string {
	const suffix = query ? `?${query}` : ''
	if (location.port === '') {
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
		return `${protocol}//${location.hostname}/ws/satellite${suffix}`
	}
	return `ws://${location.hostname}:${DIRECT_SATELLITE_PORT}/ws/satellite${suffix}`
}
