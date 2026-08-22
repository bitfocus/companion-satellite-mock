/**
 * Transport-agnostic Satellite API protocol implementation.
 *
 * Nothing in this package may import `node:net`, `ws`, or anything else that does I/O — enforced by
 * lint — so it can be unit tested in isolation and diffed against upstream when the protocol moves.
 * See docs/protocol.md and docs/design.md §5.1.
 */

export * from './constants.js'
export * from './parse.js'
export * from './serialise.js'
export * from './surface.js'
export * from './messages.js'
export * from './versions.js'

// Schemas copied verbatim from Companion — see src/upstream/ and docs/upstream.md.
export * from './upstream/SatelliteSurfaceManifestSchema.js'
export * from './upstream/SatelliteConfigFieldsSchema.js'
