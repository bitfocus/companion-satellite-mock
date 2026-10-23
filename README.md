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

Or run the published image:

```sh
docker run -p 16623:16623 -p 16624:16624 ghcr.io/julusian/companion-satellite-mock
```

Behind a reverse proxy, set `PUBLIC_ORIGIN` and `TRUSTED_PROXY_HOPS`; see
[docs/security.md](docs/security.md).

## Connecting a client

Point the client at `/ws/satellite`. Query parameters on that URL change how the server behaves for
that connection; the Network tab in the web UI builds the URL for you.

| Parameter            | Effect                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `?api=1.9.0`         | Behave as that API version: its `BEGIN`, its `CAPS` (or none), its feature set.   |
| `?subs=0`            | Advertise subscriptions as disabled, as a Companion with them switched off would. |
| `?formats=rgb,png`   | Offer only these bitmap formats, from those the version supports.                 |
| `?duplicates=strict` | Handle a duplicate device id exactly as Companion does (see docs/sessions.md).    |

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
| [`docs/shared-package-proposal.md`](docs/shared-package-proposal.md) | The original proposal for what became `@companion-app/satellite-protocol`.                                                        |

`packages/protocol/corpus/satellite-corpus.json` is a language-agnostic conformance corpus. Any
client, in any language, can run the same cases against its own parser.

## Layout

| Package      |                                                                            |
| ------------ | -------------------------------------------------------------------------- |
| `protocol`   | Pure protocol: codec, schemas, version profiles. No I/O, enforced by lint. |
| `server`     | Transport, sessions, rendering, scenarios, fault injection, tRPC API.      |
| `webui`      | React + Vite front end.                                                    |
| `testclient` | Headless satellite client for the integration tests.                       |
| `e2e`        | Playwright tests driving the built server and web UI.                      |

Node 26 · TypeScript · Express 5 · `ws` · tRPC v11 · React · `@napi-rs/canvas`

## Development

| Command          |                                                                         |
| ---------------- | ----------------------------------------------------------------------- |
| `yarn dev`       | Server with reload on change.                                           |
| `yarn dev:ui`    | Vite dev server for the web UI.                                         |
| `yarn check`     | Format, lint, typecheck and unit tests — what CI runs.                  |
| `yarn test:e2e`  | Builds everything and runs the Playwright suite.                        |
| `yarn smoke URL` | Checks a running deployment end to end, e.g. `wss://host/ws/satellite`. |

## Configuration

Everything is set by environment variable. The ones you are likely to need:

| Variable             | Default                |                                                                               |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`      | unset                  | Origin the web UI is served from. When set, the UI socket refuses any other.  |
| `TRUSTED_PROXY_HOPS` | `0`                    | Reverse proxies in front of the server. See docs/security.md before changing. |
| `SATELLITE_PORT`     | `16623`                | Satellite client listener.                                                    |
| `WEB_PORT`           | `16624`                | Web UI and its API.                                                           |
| `METRICS_PORT`       | `16625`                | Prometheus metrics, bound to `127.0.0.1` (`METRICS_BIND`).                    |
| `METRICS_TOKEN`      | unset                  | Require `Authorization: Bearer <token>` for metrics.                          |
| `LOG_LEVEL`          | `info`                 | pino log level.                                                               |
| `LOG_CLIENT_IPS`     | `1`                    | Log real client addresses alongside the hashed ones. `0` keeps only the hash. |
| `COMPANION_VERSION`  | `5.1.0+satellite-mock` | Version string reported in `BEGIN`.                                           |

The abuse limits and timeouts (`MAX_*`, `IDLE_TIMEOUT_MS`, `SESSION_GRACE_MS` and others) are listed
with their defaults in [`packages/server/src/config.ts`](packages/server/src/config.ts) and
explained in [docs/security.md](docs/security.md).

## Contributing

Issues and pull requests are welcome. `yarn check` should pass, and a change in behaviour should
come with a test.

## Licence

MIT. Parts of `packages/protocol` are copied or ported from
[Bitfocus Companion](https://github.com/bitfocus/companion), also MIT; see [LICENSE](LICENSE).
