import { z } from 'zod'

/**
 * Server configuration, entirely from the environment.
 *
 * Every limit here has a reason in docs/design.md §9.2, and every one is deliberately overridable —
 * the compatibility knobs exist so a client can be tested against Companion's real (much larger)
 * bounds, and the abuse limits exist because this runs unauthenticated on the public internet.
 */

// 0 is allowed and means "any free port" — used by the integration tests so they can run in
// parallel without fighting over a fixed port.
const port = (fallback: number) => z.coerce.number().int().min(0).max(65535).default(fallback)
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback)

export const ConfigSchema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

	/** Satellite WebSocket listener. Companion's default is 16623 and clients expect it. */
	SATELLITE_PORT: port(16623),
	SATELLITE_BIND: z.string().default('0.0.0.0'),

	/** Web UI + tRPC. */
	WEB_PORT: port(16624),
	WEB_BIND: z.string().default('0.0.0.0'),

	/** Prometheus. Bound to loopback by default — see docs/design.md §9.5. */
	METRICS_PORT: port(16625),
	METRICS_BIND: z.string().default('127.0.0.1'),
	METRICS_TOKEN: z.string().min(16).optional(),

	PUBLIC_ORIGIN: z.string().optional(),

	/**
	 * How many reverse-proxy hops to trust when reading X-Forwarded-For. 0 means take the socket
	 * address and ignore the header entirely. Getting this wrong lets a client forge its own IP and
	 * walk straight through the per-IP limits, so it has no permissive default.
	 */
	TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(4).default(0),

	/**
	 * Log the real client address alongside the hashed one.
	 *
	 * On by default because the hash alone cannot answer "was this the same address last week?" —
	 * its salt is per-process, so it changes on every restart and abuse cannot be traced across one.
	 * Set to 0 on a deployment where retaining addresses is not wanted; the hash still correlates
	 * connections within a run. Addresses are personal data in most jurisdictions, so whatever ships
	 * these logs should have a retention policy.
	 */
	LOG_CLIENT_IPS: z.coerce.number().int().min(0).max(1).default(1),

	/** Abuse limits. */
	MAX_LINE_BYTES: positive(256 * 1024),
	/**
	 * Cap on a single WebSocket frame, which is NOT the same thing as the line limit.
	 *
	 * A line may legitimately arrive split across many frames, and many lines may legitimately
	 * arrive coalesced into one — so tying this to MAX_LINE_BYTES would kill a well-behaved client
	 * that batches its writes. Its only job is to stop one enormous frame allocating unbounded
	 * memory before the line buffer ever sees it; the line limit itself is enforced by LineBuffer,
	 * which is where Companion enforces it too.
	 */
	MAX_FRAME_BYTES: positive(1024 * 1024),
	MAX_CONNECTIONS_TOTAL: positive(500),
	MAX_CONNECTIONS_PER_IP: positive(5),
	CONNECTIONS_PER_IP_PER_MINUTE: positive(30),
	CONNECTION_BURST_PER_IP: positive(10),
	MAX_MESSAGES_PER_SECOND: positive(200),
	MAX_BYTES_PER_SECOND: positive(512 * 1024),

	/** Liveness. Companion uses 5s with a 3s check interval; matching it matters for realism. */
	IDLE_TIMEOUT_MS: positive(5000),
	IDLE_CHECK_INTERVAL_MS: positive(3000),
	MAX_CONNECTION_LIFETIME_MS: positive(12 * 60 * 60 * 1000),

	/** Session continuity: how long a disconnected session survives once nobody is watching it. */
	SESSION_GRACE_MS: positive(10 * 60 * 1000),

	COMPANION_VERSION: z.string().default('5.1.0+satellite-mock'),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const parsed = ConfigSchema.safeParse(env)
	if (!parsed.success) {
		throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`)
	}
	return parsed.data
}
