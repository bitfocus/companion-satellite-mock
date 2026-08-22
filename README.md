# companion-satellite-mock

A testing and demo server that implements the Bitfocus Companion
[Satellite API](https://github.com/bitfocus/companion/wiki/Satellite-API), for developing satellite
*client* apps without a Companion install.

It exists so a client can be:

- **developed** against a controllable, inspectable server,
- **tested** against protocol versions, fault injection and awkward wire behaviour,
- **demonstrated** — anyone who connects gets a live interactive surface immediately, with no setup.

Status: **design only**. Nothing is implemented yet.

## Documentation

| Doc | Contents |
|---|---|
| [`docs/protocol.md`](docs/protocol.md) | Implementation notes that complement the [official spec](https://companion.free/for-developers/Satellite-API): wire quirks, exact bounds and error strings, liveness timing, and the version→capability matrix. |
| [`docs/design.md`](docs/design.md) | System design: pairing workflow, architecture, demo scenarios, test tooling, security model. |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | Phased build order with deliverables and acceptance criteria. |

## Shape of the thing

- Node 26 · TypeScript · Express 5 · `ws` · tRPC v11 · React + Vite · `@napi-rs/canvas`
- WebSocket transport (TCP designed for, deferred)
- All state in memory; Docker image behind a TLS reverse proxy
- Public and unauthenticated: pairing is by a claim code the surface draws on itself, and the
  security work is entirely about DoS resistance and denying any use as a relay or proxy
