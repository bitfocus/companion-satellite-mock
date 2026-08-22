import { createHash } from 'node:crypto'
import { pino, type Logger } from 'pino'
import type { Config } from './config.js'

export type { Logger }

export function createLogger(config: Config): Logger {
	return pino({
		level: config.LOG_LEVEL,
		// Payloads are truncated and bitmaps never logged — see docs/design.md §9.5.
		redact: { paths: ['bitmap', '*.bitmap', 'BITMAP', '*.BITMAP'], censor: '[bitmap]' },
		...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
	})
}

/**
 * A stable, short, non-reversible label for an IP.
 *
 * The web UI is public, so showing real addresses would leak one user's network location to another.
 * A per-process salt means the label is stable within a run — enough to correlate two connections —
 * without being a durable identifier or a lookup table anyone can precompute.
 */
const SALT = createHash('sha256').update(String(process.pid)).update(String(Date.now())).digest()

export function hashIp(ip: string): string {
	return 'ip:' + createHash('sha256').update(SALT).update(ip).digest('hex').slice(0, 8)
}

/** Truncate a value for logging, so a 2MB line can't end up in the log stream. */
export function truncate(value: string, max = 200): string {
	return value.length <= max ? value : `${value.slice(0, max)}…(${value.length} bytes)`
}
