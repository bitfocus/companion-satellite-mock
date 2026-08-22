/**
 * Transport-agnostic Satellite API protocol implementation.
 *
 * Nothing in this package may import `node:net`, `ws`, or anything else that does I/O — it is a pure
 * port of Companion's wire behaviour so that it can be unit tested in isolation and diffed against
 * upstream when the protocol moves. See `docs/protocol.md`.
 */

export const SUPPORTED_API_VERSION = '1.14.0'
