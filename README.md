# companion-satellite-mock

A test and demo server implementing the Bitfocus Companion
[Satellite API](https://companion.free/for-developers/Satellite-API), for developing satellite
_client_ apps without a Companion install.

Point a client at it and the surface comes to life immediately — no setup, no account, nothing to
configure. The surface draws its own claim code, so taking control from the web UI means reading six
characters off the buttons rather than digging a device id out of the app.

A public instance runs at **https://satellite-mock.companion.free**. Point a client at
`wss://satellite-mock.companion.free/ws/satellite`, then open the site and type in the code your
surface shows.

## Quick start

```sh
corepack enable            # or use the vendored yarn directly
yarn install
yarn build
yarn workspace @satellite-mock/webui build
node packages/server/dist/main.js
```

- Satellite clients: `ws://localhost:16623/ws/satellite`
- Web UI: `http://localhost:16624`
- Metrics: `http://127.0.0.1:16625/metrics` (loopback by default)

Or `docker compose up`, which also brings up Caddy for TLS.

`yarn check` runs format, lint, typecheck and tests.

## What it does

- **Speaks the real protocol**, quirks included — the parser is proven equivalent to Companion's by
  differential testing over 20 000 random lines, and the two schema files are copied verbatim.
- **Works with no interaction.** A client that connects gets a live, interactive surface. That is
  the zero-interaction path, and it is the default rather than a mode.
- **Shows you what it sent.** A live mirror of every control rendered from the exact style the
  device was sent, plus a protocol trace.
- **Pretends to be older.** Selecting API 1.9.0 produces a server that sends no `CAPS` line at all,
  rejects `ADD-SUB`, and drops `LOCATION` — not just a different banner.
- **Misbehaves on demand.** Latency, jitter, drops, duplicates, unanswered pings, and frame
  splitting — the last of which breaks any client assuming one WebSocket frame is one message, and
  which passes every ordinary test.

## Documentation

| Doc                                                                  | Contents                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/scenarios.md`](docs/scenarios.md)                             | What each demo mode is for, and how to add one.                                                                                   |
| [`docs/security.md`](docs/security.md)                               | Limits, the two structural properties, and what to set before going public.                                                       |
| [`docs/protocol.md`](docs/protocol.md)                               | Implementation notes complementing the official spec: wire quirks, exact bounds and error strings, the version→capability matrix. |
| [`docs/sessions.md`](docs/sessions.md)                               | How claiming works, what survives a reconnect, and duplicate device ids.                                                          |
| [`docs/upstream.md`](docs/upstream.md)                               | What is copied from Companion, what is ported, how to refresh each.                                                               |
| [`docs/shared-package-proposal.md`](docs/shared-package-proposal.md) | Proposal for extracting a shared `@companion-app/satellite-protocol`.                                                             |

`packages/protocol/corpus/satellite-corpus.json` is a language-agnostic conformance corpus. Any
client, in any language, can run the same cases against its own parser.

## Layout

| Package      |                                                                            |
| ------------ | -------------------------------------------------------------------------- |
| `protocol`   | Pure protocol: codec, schemas, version profiles. No I/O, enforced by lint. |
| `server`     | Transport, sessions, rendering, scenarios, fault injection, tRPC API.      |
| `webui`      | React + Vite front end.                                                    |
| `testclient` | Headless satellite client for the integration tests.                       |

Node 26 · TypeScript · Express 5 · `ws` · tRPC v11 · React · `@napi-rs/canvas`
