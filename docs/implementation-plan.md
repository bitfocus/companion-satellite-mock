# Implementation plan

Read [`design.md`](./design.md) first; this is the build order. Each phase lists the work, what it
produces, and how you know it's done. Phases are sequenced so that something demonstrable exists
early (a client can connect and see buttons at the end of Phase 5, before any UI exists).

Estimates are relative sizes (S/M/L), not calendar time.

---

## Phase 0 — Scaffolding and de-risking (M) — ✅ done

**Done first, because it de-risks the one native dependency.**

1. Repo layout: yarn 4 workspaces — `packages/protocol`, `packages/server`, `packages/webui`,
   `packages/testclient`.
2. Node 26: `.node-version`, `engines`, `"type": "module"`, TypeScript 5.x strict with project
   references, `moduleResolution: nodenext`.
3. Tooling: ESLint (flat config) + Prettier in the Bitfocus house style, `vitest`, `lint-staged`.
4. ~~**Spike `@napi-rs/canvas` on Node 26**~~ — **done**, results in
   [design.md §6](./design.md#6-rendering). It loads from prebuilds on Node 26.7.0 x64 with no build
   step; use `canvas.data()` (premultiplied — keep buttons opaque) over `getImageData()`; PNG is
   both cheaper and 13× smaller than raw RGB. Still to confirm on the deploy architecture if it is
   arm64, and inside the final container image.
5. Dockerfile (multi-stage, non-root, read-only rootfs, `--init`, healthcheck) and a
   `docker-compose.yml` with a Caddy TLS front end as the deployment reference.
6. CI: lint, typecheck, unit tests, docker build.

**Done when:** `yarn build && yarn test` is green in CI and the container starts and renders a PNG
button on the target architecture.

**Outcome.** `yarn check` (format, lint, typecheck, test) and the webui build are green on Node
26.7.0 with Yarn 4.10.3. Two design invariants are enforced by lint rather than by good intentions,
and both were verified to fire: `packages/protocol` may not import anything that does I/O, and
`packages/server` may not use `fetch` or an HTTP client library (see
[design.md §9.1](./design.md#91-the-two-structural-properties)). Yarn is vendored at
`.yarn/releases/` rather than fetched by corepack, so CI and the Docker build are reproducible and
need no network beyond the registry. Container build and arm64 confirmation are still outstanding.

---

## Phase 1 — `packages/protocol` (L) — ✅ done

The core asset. No I/O, no timers.

1. `parseLine` — port of upstream `parseLineParameters` with every quirk from
   [protocol.md §1](./protocol.md#1-wire-quirks).
2. `serialise` — `sendMessage` equivalent, trailing-space quirk on by default and toggleable,
   `\n`/`\r\n` selectable.
3. Schemas: **copy Companion's two zod schema files verbatim** — they import nothing but `zod`, and
   they are the source of truth the published JSON assets are generated from, so copying them gives
   runtime validation rather than just types. See [upstream.md](./upstream.md). Hand-write zod for
   `ADD-DEVICE` params, `VARIABLES` and the inbound command shapes. Decoders that size-check base64 before decoding and JSON before parsing.
4. `ApiVersionProfile` — the version→capability table from
   [protocol.md §6](./protocol.md#6-version--capability-matrix) with `capabilitiesFor(v)`
   returning: accepted commands, permitted `KEY-STATE`/`SUB-STATE` args, `LOCATION` on/off,
   rotation semantics, offered bitmap formats, `CAPS` contents.
5. Message builders for every outbound message, each gated by a capability profile.
6. Tests: golden corpus of lines → parses; every error string from
   [protocol.md §3](./protocol.md#3-error-strings); a round-trip property test
   (`serialise(parse(x))`); capability-gating tests asserting that e.g. profile 1.6.0 emits no
   `LOCATION` and rejects `ADD-SUB`.

**Done when:** the package has no dependency on `node:net`/`ws`, and its test suite covers every
quirk in [protocol.md §1](./protocol.md#1-wire-quirks) explicitly.

**Outcome.** 191 tests. The parser and serialiser are ported with every wire quirk and proven
equivalent by a differential test against a verbatim copy of upstream's function over 20 000 seeded
random lines. The two manifest/config-field schemas are copied verbatim from Companion and excluded
from lint and formatting so refreshes stay clean diffs. `capabilitiesFor()` derives the version
profile, and every message builder is gated by it — at 1.6.0 the builders emit no `CAPS`, no
`LOCATION`, no `LEDS`, no `TEXTCOLOR` and no `DEVICEID` on responses.

`corpus/satellite-corpus.json` is a hand-authored conformance corpus — written from Companion's
documented behaviour, _not_ generated from this implementation, so it can disagree with us and win.
It ships as plain JSON so a client in any language can run the same cases, which is the one thing
prose about the trailing-space quirk can never do.

---

## Phase 2 — Transport and connection lifecycle (M) — ✅ done

1. Express 5 app; `ws` server mounted at `/ws/satellite`.
2. `SatelliteConnection` abstraction (`send`, `destroy`, `remoteAddress`, `kind`, byte counters) with
   the WS implementation; the TCP implementation is a stub with the same interface, not wired up.
3. Receive buffering, line splitting, `MAX_LINE_LENGTH` guard → `ERROR ERROR MESSAGE="Line too long"`
   then destroy.
4. `PING`/`PONG` both directions; idle timeout matching upstream (5 s, 3 s check interval) and
   configurable.
5. Connection registry with the per-IP and global caps, and the inbound token buckets from
   [design.md §9.2](./design.md#92-limits).
6. Structured logging with a per-connection logger; graceful shutdown that closes all sockets.

**Done when:** a raw `wscat` session receives `BEGIN` + `CAPS`, is kept alive by pings, is dropped
after 5 s of silence, and the caps are demonstrably enforced by a small abuse script.

**Outcome.** 238 tests. 14 of them drive a real WebSocket against a real listener, because the
interesting failures in a transport are in the wiring, not the pieces: handshake, raw `PING` echo, a
command split one byte per frame, many commands coalesced into one frame, unknown-command error,
case-insensitive dispatch, `QUIT`, the doubled-`ERROR` line-too-long response, idle timeout firing,
a pinging connection _not_ timing out, per-IP admission and slot release, and a 426 for plain HTTP.

Two things worth recording:

- **The frame cap and the line cap are different limits**, and the integration test is what proved
  it. `ws`'s `maxPayload` had been wired to `MAX_LINE_BYTES`, which is wrong in both directions: a
  line may arrive split across many frames, and many lines may arrive coalesced into one, so a
  client that batches its writes would have been killed. `MAX_FRAME_BYTES` is now separate and only
  exists to stop one enormous frame allocating before the line buffer sees it — the line limit is
  enforced by `LineBuffer`, where Companion enforces it too.
- **The connection registry does not spend a rate-limit token on a connection it refuses for being
  over the concurrent limit.** Otherwise a client sitting at its limit also accrues a lockout it has
  to wait out after disconnecting, turning a soft limit into a punitive one.

---

## Phase 3 — Devices, surfaces and sessions (L) — ✅ done

1. `ADD-DEVICE`: full validation and error paths, both legacy and manifest registration, normalised
   into the internal `Surface` model. `REMOVE-DEVICE`, `QUIT`.
2. Reserved-prefix rules, duplicate handling (including the "error goes to the _existing_ socket"
   quirk), multiple devices per connection.
3. `KEY-PRESS`, `KEY-ROTATE`, `PINCODE-KEY`, `SET-VARIABLE-VALUE`, `CHANGE-PAGE`,
   `FIRMWARE-UPDATE-INFO` (store as inert text; the only wire effect is the `OK`, so the web UI must report it), `ADD-SUB`/`REMOVE-SUB`/`SUB-PRESS`/`SUB-ROTATE`.
   Legacy `KEY` parsing accepts both flat index and `row/column`.
4. Session manager: session per connection keyed by primary device id, claim code generation
   (Crockford base32, 6 chars), claim/unclaim, reconnect rebinding with a grace window, TTLs, GC.
5. Per-session trace ring buffer with payload elision.

**Done when:** the headless test client (Phase 6a) can register legacy and advanced surfaces, all
error paths return upstream's exact strings, and disconnect/reconnect restores the same session.

**Outcome.** 321 tests. Legacy and manifest registrations normalise into one internal surface, so
drawing code addresses controls by id and only the emitter knows which mode the client used. Every
inbound command is implemented with upstream's validation order and exact error strings, and the
command map is built per connection from the capability profile — a version that predates a command
answers `Unknown command`, as a server of that vintage would.

Two upstream quirks are reproduced deliberately, each with a test explaining why: `ADD-DEVICE`
checks only the resolved `SERIAL` for reserved prefixes (so a reserved `DEVICEID` with a clean
`SERIAL` is accepted), and a device-id collision reports to the connection that already holds the id
while the requester gets no reply at all.

Sessions are keyed for continuity by primary device id, so a reconnect lands back in the same
session with its claim, settings and trace intact. The claim code is six characters of an alphabet
with `I`, `L`, `O` and `U` removed and input folded, because it is read off a button and typed into
a browser — the characters people misread matter more than the extra entropy, and the attempt
limiter is what makes the length sufficient. Comparison is constant time, and unclaiming mints a
fresh code.

Collection needs _both_ ends gone: the client disconnected **and** no browser watching. An operator
with the tab open keeps a crashed client's session, which is the behaviour that matters
mid-debugging; the absolute lifetime cap is what stops a forgotten tab holding one open forever.

---

## Phase 4 — Renderer (M) — ✅ done

1. Button renderer on `@napi-rs/canvas`: background, border, text with wrapping and `auto` sizing,
   pressed treatment, `PAGEUP`/`PAGEDOWN`/`PAGENUM` glyphs, rotation.
2. LED sampling: gauge value → per-segment RGB for `full-ring` and `simple` modes.
3. Encoders: raw RGB base64; PNG/WebP as `data:` URLs.
4. LRU cache keyed by `hash(style)+size+format+rotation` with a byte budget; render semaphore;
   per-session pixel-rate ceiling; dimension caps enforced at `ADD-DEVICE` time.
5. Benchmarks for cold and warm render paths, checked into the repo.

**Done when:** a full 32-key surface of _unique_ content renders cold in ≤15 ms (the spike measured
12 ms, so this is a regression guard rather than a target), and the cache hit rate on a repeating
animation is >95%.

---

## Phase 5 — Emitter and write queue (M) — ✅ done

1. `buildStyleArgs` equivalent: `PRESSED`, `TYPE`, `BITMAP`, `COLOR`, `TEXTCOLOR`, `TEXT`,
   `FONT_SIZE`, `LEDS` — each gated by both the control's style preset and the capability profile.
2. `KEY-STATE` (with `KEY` vs `CONTROLID` and `LOCATION`), `SUB-STATE`, `KEYS-CLEAR`, `BRIGHTNESS`,
   `LOCKED-STATE`, `VARIABLE-VALUE` (debounced like upstream), `DEVICE-CONFIG`.
3. Per-control latest-wins write queue with a bounded byte budget and overflow → terminate.

**Milestone: end-to-end without a UI.** A hard-coded surface can be driven from a script and a real
client shows buttons and reports presses.

**Outcome.** 366 tests. Latest-wins coalescing per control, so a control drawn three times before
the flush is sent once with the newest style; backpressure that drops the queue and closes rather
than buffering without limit; and every field gated by both the client's style preset and the
capability profile.

---

## Phase 6 — Test client and scenario engine (L)

### 6a — `packages/testclient` (S, pull earlier if useful)

A headless satellite client built on `packages/protocol`: connects, registers a configurable surface,
logs everything, can send scripted input. Used by integration tests and as a manual probe. Build this
as soon as Phase 2 lands if it speeds up development.

### 6b — Scenario engine (M)

1. `Scenario` interface and `ScenarioContext` as in [design.md §7](./design.md#7-demo-modes-scenarios).
2. Single shared tick timer for all sessions with a global work budget.
3. Feature detection and graceful degradation; per-scenario zod param schemas.
4. Scenario registry and lifecycle (attach/detach/switch, dispose cleanly).

### 6c — Scenarios, in value order (L)

1. **Unclaimed** — first, it's the default and the zero-interaction path.
2. **Input echo** — earns its keep immediately during client development.
3. **Companion Home** — the demo/screenshot scenario.
4. **Colour & text matrix**, **Bitmap torture**.
5. **Encoder lab**, **Pincode lock**, **Brightness**.
6. **Variables**, **Device config**, **Subscriptions**.
7. **Attract / animation**.

**Done when:** each scenario has an integration test driving it through the headless client and
asserting on the emitted lines.

---

## Phase 7 — tRPC API and web UI (L)

1. tRPC v11 router over `/ws/trpc` with `Origin` checking, zod inputs everywhere, per-client and
   per-IP mutation rate limits:
   - `session.claim` / `unclaim` / `get`, `session.subscribe` (live state)
   - `scenario.list` / `select` / `setParams`
   - `protocol.getProfile` / `setPendingProfile` / `applyAndBounce`
   - `chaos.*`, `stress.start` / `stop`, `raw.send`
   - `trace.subscribe`, `input.subscribe`
   - `admin.*` behind a token
2. Vite + React app:
   - **Home**: what this is, the exact WS URL, claim-code entry.
   - **Session**: surface mirror, input log, protocol trace, connection info, sidebar controls.
   - **About/help**.
3. Coalesce and throttle subscription updates (e.g. 10 fps for the surface mirror) so the UI can't
   DoS the server or itself; send previews as PNG data URLs from the existing render cache.

**Done when:** claim → pick scenario → watch the mirror update in step with the real device works
end to end.

---

## Phase 8 — Fault injection (M)

1. Chaos middleware on both directions: latency/jitter, drop, duplicate, reorder, frame
   split/coalesce, slow write, oversized line.
2. Connection tools: graceful/abrupt disconnect, close codes, refuse-reconnect modes, ping
   misbehaviour, idle-timeout knob.
3. Protocol profile switching: pending profile + _Apply & bounce_; sticky per-device overrides;
   server-defined named profiles selectable via `?profile=`.
4. Hard ceilings on every knob; all tools scoped to the claimed session only.

**Done when:** a client can be shown to survive (or be shown _not_ to survive) one-byte-per-frame
delivery, a 1.6.0 server, and a 30 s reconnect blackout.

---

## Phase 9 — Bounded load tool (S)

Payload sweep rather than raw flood: N controls at F fps for D seconds at a chosen bitmap size and
format, with the caps and the UI caveat from
[design.md §8.4](./design.md#84-load--throughput-bounded). Live throughput chart. Auto-stop.

---

## Phase 10 — Hardening and ops (M)

1. Security pass against the [design.md §9](./design.md#9-security-and-abuse-resistance) checklist,
   with a test per limit.
2. Abuse simulation: connection floods, slow-loris, oversized lines, claim brute force, many
   concurrent sessions. Assert on memory and CPU ceilings.
3. Soak test: 50 headless clients × 1 h, watch RSS and handle counts for leaks.
4. Invariant test: `packages/server` has no HTTP-client dependency and makes no outbound connections.
5. `/healthz`, optional `/admin`; container hardening; reverse-proxy config with trusted-proxy hops;
   log hygiene (no bitmaps, hashed IPs).
6. **Prometheus metrics** on a separate listener with an optional bearer token, per
   [design.md §9.5](./design.md#95-operations). Land the listener and the transport/session/render
   counters here; each earlier phase adds its own metrics as it goes, rather than retrofitting them.
   Verify the default configuration is unreachable from the public origin.

---

## Phase 11 — Docs and App-review readiness (S)

1. `README.md` quickstart; keep `docs/protocol.md`, `docs/design.md` current; add
   `docs/scenarios.md` and `docs/security.md`.
2. Deployment runbook for the public instance, with a post-deploy smoke test that connects the
   headless client and asserts it sees the Unclaimed surface.
3. A short note for client evaluation describing the demo server and what an evaluator will see.
4. Refresh `docs/protocol.md` against the then-current upstream commit and record the hash.

---

## Deferred (explicitly out of v1)

TCP listener (the abstraction is in place — expect ~100 lines plus its own rate limits and the loss
of `Origin`-based defences); the malformed/hostile-input tool suite (the raw sender covers it by
hand); persistence; session record/replay; multi-viewer sessions; i18n.

---

## Suggested order of first commits

1. Phase 0 scaffolding + the canvas spike.
2. `packages/protocol` parser/serialiser with the quirk tests — the highest-value, most reusable
   piece, and it can be verified against upstream without any server.
3. Phase 2 transport, then `packages/testclient`, then Phase 3.
