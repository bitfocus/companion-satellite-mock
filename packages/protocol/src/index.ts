/**
 * Transport-agnostic Satellite API protocol implementation.
 *
 * Nothing in this package may import `node:net`, `ws`, or anything else that does I/O — enforced by
 * lint — so it can be unit tested in isolation. The wire codec, schemas and constants are
 * Companion's own, from `@companion-app/satellite-protocol`; this package adds what the mock needs on
 * top. See docs/protocol.md.
 */

export * from './configValues.js'
export * from './constants.js'
export * from './parse.js'
export * from './serialise.js'
export * from './surface.js'
export * from './messages.js'
export * from './variables.js'
export * from './versions.js'

// Companion's own schemas, used as-is.
export * from '@companion-app/satellite-protocol/schemas'
