/**
 * Headless satellite client, built on `@satellite-mock/protocol`.
 *
 * Used by the integration tests and as a manual probe against a running server. Deliberately shares
 * no code with the server beyond the protocol package, so a bug in one does not mask itself in the
 * other.
 */

export {}
