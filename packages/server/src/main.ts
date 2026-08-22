import { loadConfig } from './config.js'
import { createLogger } from './logging.js'
import { MetricsServer } from './metrics.js'
import { MockRuntime } from './runtime.js'
import { SatelliteServer } from './satelliteServer.js'
import { WebServer } from './web/webServer.js'

const config = loadConfig()
const logger = createLogger(config)

const runtime = new MockRuntime({ config, logger })
const metrics = new MetricsServer(config, logger)

const satellite = new SatelliteServer({
	config,
	logger,
	events: {
		...runtime.events(),
		onLine: (session, direction, line) => {
			// record() elides bitmap payloads and drops keepalives; see formatForTrace.
			runtime.sessions.forConnection(session)?.record(direction, line)
			metrics.messages.inc({ direction, command: line.split(' ')[0]?.toUpperCase() ?? 'UNKNOWN' })
			metrics.bytes.inc({ direction }, Buffer.byteLength(line))
		},
	},
})

runtime.start()
await satellite.listen()

const web = new WebServer({ config, logger, runtime })
await web.listen()

await metrics.listen(() => metrics.sample(satellite, runtime))

logger.info(
	{
		satellite: `ws://${config.SATELLITE_BIND}:${config.SATELLITE_PORT}/ws/satellite`,
		web: `http://${config.WEB_BIND}:${config.WEB_PORT}`,
	},
	'companion-satellite-mock ready'
)

let shuttingDown = false
const shutdown = (signal: string): void => {
	if (shuttingDown) return
	shuttingDown = true
	logger.info({ signal }, 'shutting down')

	void Promise.all([satellite.close(), web.close(), metrics.close()])
		.then(() => {
			runtime.stop()
			process.exit(0)
		})
		.catch((error: unknown) => {
			logger.error({ err: error }, 'error during shutdown')
			process.exit(1)
		})
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
