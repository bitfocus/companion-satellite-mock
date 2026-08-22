import { loadConfig } from './config.js'
import { createLogger } from './logging.js'
import { SatelliteServer } from './satelliteServer.js'

const config = loadConfig()
const logger = createLogger(config)

const satellite = new SatelliteServer({ config, logger })
await satellite.listen()

const shutdown = (signal: string): void => {
	logger.info({ signal }, 'shutting down')
	void satellite.close().then(
		() => process.exit(0),
		(error: unknown) => {
			logger.error({ err: error }, 'error during shutdown')
			process.exit(1)
		}
	)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
