# companion-satellite-mock — system design

A test/demo server that speaks Bitfocus Companion's [Satellite API](./protocol.md) so that a
satellite _client_ can be developed, exercised and demonstrated without a real
Companion install — including by someone who will never open the web UI.

## 1. Goals

1. **Protocol fidelity.** A faithful reimplementation of Companion's satellite server, quirks
   included, so that "works against the mock" means something.
2. **Zero-config demo.** Any client that connects gets a live, interactive surface immediately.
3. **Controllable.** A web UI to drive a connected client: pick demo content, inject faults, change
   the advertised API version, and see exactly what the server thinks it sent.
4. **Safe in public.** It will sit on the open internet unauthenticated. It must be uninteresting to
   abuse and impossible to exhaust.

## 2. Non-goals

- Not a Companion replacement. No modules, actions, feedbacks, expression engine, or real pages.
- No persistence. Restart = clean slate; clients rebuild their sessions on reconnect.
- No user accounts, no session confidentiality (explicitly out of scope — obscurity is enough).
- TCP transport is _designed for_ but not shipped in v1.

## 3. Decisions

| Decision          | Choice                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| Runtime           | Node 26, TypeScript (ESM, strict), yarn 4 workspaces                                   |
| HTTP/API          | Express 5 + `ws`; tRPC v11 over a WebSocket link for the UI                            |
| Web UI            | React + Vite + tRPC client                                                             |
| Rendering         | `@napi-rs/canvas` for drawing **and** PNG/WebP encoding                                |
| Pairing           | Claim-by-device-id (see §4) — transport-agnostic, works for TCP later                  |
| Transports        | WebSocket only in v1; transport abstraction present from day one                       |
| Unclaimed clients | Auto-attach a live demo surface that displays its unclaimed state + claim code         |
| State             | All in memory                                                                          |
| Deployment        | Docker image behind a TLS reverse proxy                                                |
| Access            | Public, unauthenticated, hardened and rate limited                                     |
| Test tools        | Protocol/version knobs, connection chaos, bounded load. Malformed-input suite deferred |

## 4. Workflow

### 4.1 The problem with raw device ids

Claim-by-device-id is the right model (it works over TCP, and it means a client needs no
mock-specific configuration beyond a URL) but naked device ids are a poor UX and a poor key:
they're long, the user has to find them inside the app, and on a public server they're enumerable —
anyone could claim someone else's connection by guessing `streamdeck:1`.

### 4.2 The claim code

**The surface tells you its claim code by drawing it.**

1. Client connects and sends `ADD-DEVICE`.
2. Server creates a **session** and generates a 6-character claim code from an unambiguous alphabet
   (Crockford base32, no `I`/`L`/`O`/`U`), rendered as `K7M-2QP`.
3. The **Unclaimed** scenario attaches immediately and draws, using whatever the surface asked for
   (bitmaps, or colours+text, or colours alone):
   - a header button reading `UNCLAIMED`,
   - the claim code, one character per key on small surfaces or as a single text button,
   - the server's public URL,
   - two or three live buttons that respond to presses and rotation, so the surface is visibly alive.
4. The user opens the web UI, types the code, and the session is claimed by that browser.
5. On claim the session switches to the default demo scenario and the full control panel appears.

Benefits: nothing to copy out of the app; enumeration is defeated by a ~10^9 code space plus rate
limiting; it works identically over TCP; and the zero-interaction path is exactly the desired one — connect,
see a working, interactive, self-explanatory surface.

### 4.3 Session identity and continuity

- A **session** corresponds to one _connection_, keyed for continuity by its **primary device id**
  (the first `ADD-DEVICE` on that connection).
- Reconnecting with the same primary device id rebinds to the existing session within a grace
  window, restoring its scenario, chaos settings, protocol profile and claim — so the claim survives
  a reconnect and the surface does not bounce back to Unclaimed. The target is gaps of a minute or
  less (app backgrounded, network flap, an _Apply & bounce_ version change); the default window is
  10 min, which is generous for that and still cheap, since a session is a few KB of memory and a
  ring buffer. Nothing is persisted — a server restart legitimately drops everything, and clients
  reconnect into fresh Unclaimed sessions.
- This does mean the **client must keep its `DEVICEID` stable across reconnects**. One that mints a
  new id per launch gets a new session and a new claim code every time; the UI calls that out when
  it sees a session go idle and an identical-looking device appear beside it.
- The claim code is stable for the lifetime of the session and rotates on unclaim.
- A session has **zero or one controller** (a browser, identified by an opaque `uiClientId` in
  `localStorage`). Others may not view it at all: full session detail — including the trace, which
  contains device ids and payloads — requires the code. There is no public browsable list.
- Explicit unclaim, controller idle timeout, or session expiry returns the surface to Unclaimed and
  re-draws a fresh code.
- **A subscribed browser keeps the session alive too.** The GC window starts only once _both_ ends
  are gone: the satellite connection has dropped **and** no controller is actively subscribed. So a
  client that vanishes while the operator still has the tab open keeps its claim, scenario, chaos
  settings and trace indefinitely — the UI just shows the device as offline, which is the behaviour
  you want when you're mid-debugging and the app crashes. "Actively subscribed" means a live tRPC
  subscription with a heartbeat, not merely "claimed at some point", so a closed laptop lid releases
  it on the normal window.
- Because that lets a browser hold a session open indefinitely, it is bounded: at most 4 held
  sessions per UI client, and an absolute session lifetime cap of 12 h regardless of activity. A
  session is only a few KB plus its ring buffer, so this is cheap.

### 4.4 Multiple devices per connection

The protocol allows one connection to register several surfaces, and the reference client does.
The session owns a map of devices; the UI shows a device switcher within a session. The claim code
is drawn on every surface belonging to the session.

## 5. Architecture

```
packages/
  protocol/   pure, no I/O: line codec, message schemas, version→capability profiles
  server/     transports, connection/session model, renderer, scenarios, tools, tRPC router
  webui/      React + Vite + tRPC client
  testclient/ headless satellite client used by integration tests (and handy for manual poking)
```

### 5.1 `packages/protocol`

No sockets, no timers, no Node built-ins beyond `Buffer`. Everything here is unit-testable in
isolation and is the piece that gets diffed against upstream when Companion moves.

- `parseLine(line): ParsedParams` — a faithful port of `parseLineParameters`, quirks intact.
- `serialise(messageName, status, deviceId, args): string` — including the trailing-space quirk,
  toggleable via an option so the chaos tool can turn it off.
- Zod schemas for `LAYOUT_MANIFEST`, `CONFIG_FIELDS`, `VARIABLES`, and for every command's params.
- `ApiVersionProfile`: a table mapping an advertised API version to a capability set —
  which commands are accepted, which `KEY-STATE` args may be emitted, whether `LOCATION` is sent,
  whether `DIRECTION` may exceed ±1, which bitmap formats are offered, what `CAPS` contains.
  **Every outbound field and every inbound command handler consults this object**, which is what
  makes the version knob real rather than cosmetic.
- Golden-file tests: a corpus of lines in/out with expected parses, plus the exact error strings.

### 5.2 `packages/server` layers

1. **Transport adapter.** `SatelliteTransport` yields `SatelliteConnection` objects with
   `send(line)`, `destroy()`, `remoteAddress`, `kind: 'ws' | 'tcp'`, plus byte counters. The WS
   adapter feeds frame text into the shared receive buffer; a TCP adapter is a later drop-in.
   Mirrors upstream's `SatelliteSocketWrapper` so the port stays diffable.
2. **Protocol engine.** Per-connection: receive buffer + line splitting + length guard, command
   dispatch, device registry, subscription registry, error formatting. Emits domain events
   (`deviceAdded`, `keyPress`, `rotate`, `variableSet`, `pincodeKey`, `changePage`, `subAdded`, …)
   and accepts outbound intents (`drawControl`, `clearKeys`, `setBrightness`, `setLocked`,
   `sendVariable`, `sendDeviceConfig`).
3. **Surface model.** Normalises legacy (`KEYS_TOTAL`/`KEYS_PER_ROW`/flags) and advanced
   (`LAYOUT_MANIFEST`) registrations into one internal shape:
   `Surface { mode, gridSize, controls: Map<controlId, {row, column, style}> }`. Drawing code always
   addresses controls by id; the emitter converts to `KEY=` or `CONTROLID=` based on mode. This is
   exactly what Companion does internally, so behaviour matches for free.
4. **Button state + renderer.** Each control holds a `ButtonStyle`
   `{bgColor, textColor, text, fontSize, pressed, type, leds?}`. Render pipeline:
   style → canvas → RGB buffer / PNG / WebP, at the per-control size, honouring rotation.
5. **Scenario engine.** See §7.
6. **Session manager.** Sessions, claim codes, claim/unclaim, TTLs, the per-session trace ring
   buffer, per-session tool configuration.
7. **tRPC router + subscriptions.** See §8.
8. **Guards.** Rate limiters, quotas, caps — see §9.

### 5.3 Data flow

```
client ──ws──► transport ──lines──► protocol engine ──events──► scenario engine
                                          ▲                          │
                                          │                    button state
                                    chaos middleware                 │
                                          │                          ▼
client ◄──ws── transport ◄──lines── emitter ◄── write queue ◄──── renderer
                                          │
                                          └──► trace ring buffer ──► tRPC subscription ──► web UI
```

The chaos middleware sits between the emitter and the transport (outbound) and between the transport
and the engine (inbound), so latency/drop/duplicate/split can be applied without any other layer
knowing.

## 6. Rendering

`@napi-rs/canvas` draws each button: background fill, optional border, text with wrapping and
`auto` sizing that approximates Companion's, a pressed-state treatment, and glyphs for
`PAGEUP`/`PAGEDOWN`/`PAGENUM`. LED strips are sampled from a gauge value into an RGB triple array.

- **Encoders:** raw RGB (`w*h*3`, base64) for `rgb`; `canvas.encode('png'|'webp')` wrapped in a
  `data:` URL for the others. Format follows the per-device/per-subscription negotiation.

### Measured (Phase 0 spike, Node 26.7.0 / `@napi-rs/canvas` / x64)

The spike ran before any design was committed to; the numbers moved two decisions.

| Operation (72×72 button)                          | ms/op                     |
| ------------------------------------------------- | ------------------------- |
| draw only                                         | 0.068                     |
| `getImageData()` + naive RGBA→RGB loop            | ~1.14                     |
| **`canvas.data()` + tight indexed loop**          | **0.144**                 |
| `toBuffer('image/png')`                           | 0.42                      |
| `toBuffer('image/webp')`                          | 0.66                      |
| Full unique 32-key surface, draw + rgb, fast path | **12.0** (was 43.6 naive) |

Payloads for that button: `rgb` 15552 B, `png` 1155 B, `webp` 1168 B.

Three conclusions:

1. **Use `canvas.data()`, not `getImageData()`** — 13× cheaper, and the RGBA→RGB loop must be written
   with explicit indexing (`out[o]=…; o+=3`) rather than `o++` per channel, which is a further 3.4×.
   Together they take a cold full-surface redraw from 44 ms to 12 ms, comfortably inside a 30 fps
   frame even with every button unique.
2. **`canvas.data()` returns _premultiplied_ RGBA; `getImageData()` returns _straight_.** This is
   the one to get right — it has bitten Companion. Measured on a 50%-alpha white pixel over nothing:

   | source                          | pixel      | drop alpha → rgb                  |
   | ------------------------------- | ---------- | --------------------------------- |
   | `canvas.data()` (premultiplied) | `7f7f7f7f` | `7f7f7f` — composited on black ✅ |
   | `getImageData()` (straight)     | `ffffff7f` | `ffffff` — ignores alpha ❌       |

   Companion resolves this the same way: `transformButtonImage` documents its input as _straight_
   alpha RGBA and converts with `premultiplyAlpha: targetFormat.length === 3` — i.e. **the `rgb` wire
   format is premultiplied**, because dropping a channel from straight-alpha data is simply wrong.

   So the rule is not "either works, because buttons are opaque". It is:

   - **`rgb` path → `canvas.data()`**, which is both the fast path _and_ the correct one, matching
     Companion byte for byte.
   - **`png`/`webp` path → `canvas.toBuffer()`/`encode()`**, which keep the alpha channel and must
     therefore see _straight_ alpha. Never hand an encoder `data()` bytes: premultiplied values
     written as straight ones darken every semi-transparent pixel.
   - Unit-test both paths against a **semi-transparent fixture**, not just an opaque one. An opaque
     fixture passes under either mistake, which is exactly how this class of bug survives review.

3. **PNG is cheaper than raw RGB _and_ 13× smaller on the wire** — the encode costs less than the
   RGBA→RGB conversion it replaces. So `png` is the preferred format to negotiate whenever a client
   can decode it, and `rgb` is the compatibility path rather than the fast path. Worth telling client
   authors.

Also measured: `canvas.encode()` (the promise-returning form) does **not** meaningfully free the
event loop — 200 parallel encodes ticked a 1 ms interval only twice. Treat encoding as blocking CPU
work: the render semaphore is doing real work, and if encoding ever becomes the bottleneck the answer
is `worker_threads`, not `await`.

- **Cache.** Keyed by `hash(style) + size + format + rotation`. Demo content is highly repetitive
  (same colours, same labels, animation frames that recur), so the cache turns the animation and
  load tools from a CPU problem into a memcpy. Bounded LRU with a byte budget.
- **Budget.** A global render semaphore (small, e.g. 4) plus a per-session pixels/second ceiling.
  Bitmap dimensions are capped (default 512×512); an `ADD-DEVICE` asking for more is rejected with a
  protocol error rather than accepted and quietly clamped, so client bugs surface.
- **Non-square** support is real (the manifest carries `w`/`h`), and `CAPS NONSQUARE` reflects the
  active protocol profile.

## 7. Demo modes (scenarios)

A scenario is a small module:

```ts
interface Scenario {
  id: string
  name: string
  description: string
  requires?: ScenarioFeature[] // e.g. 'bitmaps', 'leds', 'variables', 'pincode'
  params?: ZodSchema // rendered as a form in the web UI
  init(ctx: ScenarioContext): void
  onPress?(ctx, controlId, pressed): void
  onRotate?(ctx, controlId, delta): void
  onVariable?(ctx, id, value): void
  onPincodeKey?(ctx, digit): void
  tick?(ctx, dtMs): void
  dispose?(ctx): void
}
```

`ScenarioContext` exposes `setControl(id, style)`, `clearAll()`, `setBrightness(v)`,
`setLocked(locked, count)`, `sendVariable(id, value)`, `sendDeviceConfig(values)`, `surface`,
`params`, and `log()`. Scenarios never touch sockets. All ticks are driven from a single shared
timer with a global budget, so N sessions cost one timer.

Scenarios **degrade**: one that wants bitmaps still works on a colour+text-only surface. The UI
shows which features the connected client actually negotiated, and greys out what it can't use.

### The catalogue

| #   | Scenario                 | What it demonstrates / tests                                                                                                                                                                                              |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Unclaimed** (auto)     | Claim code + liveness. Press/rotate feedback. The zero-interaction surface.                                                                                                                                                 |
| 2   | **Companion Home**       | A believable Companion page: `PAGEUP`/`PAGEDOWN`/`PAGENUM` buttons, realistic labels (`CAM 1`, `ATEM PGM`), `LOCATION` set, press latching, page navigation via `CHANGE-PAGE`. The screenshot/demo-video scenario.        |
| 3   | **Input echo**           | The surface displays what the server received: last key index _and_ how it was interpreted (flat index vs `row/col`), press/release timing, rotation deltas. The single best tool for verifying a client's input mapping. |
| 4   | **Colour & text matrix** | Every button a different colour; text with unicode, emoji, RTL, very long strings, embedded newlines; `FONT_SIZE` numeric and `auto`; both `hex` and `rgb` colour formats.                                                |
| 5   | **Bitmap torture**       | Gradients, 1px checkerboards, numbered corner markers, orientation arrows, per-control differing sizes, non-square controls, format sweep (rgb / png / webp). Catches scaling, orientation, stride and decode bugs.       |
| 6   | **Encoder lab**          | Encoders with LED rings: draws a gauge, emits `LEDS`, and prints the raw received `DIRECTION` so 1.14 multi-step rotation can be verified against ±1 legacy behaviour.                                                    |
| 7   | **Pincode lock**         | Drives `LOCKED-STATE` with `CHARACTER_COUNT` and `ROTATION`; validates `PINCODE-KEY` in `FULL` mode; a correct PIN unlocks. Also exercises the "no drawing while locked" rule.                                            |
| 8   | **Brightness**           | Ramps, steps and extremes of `BRIGHTNESS`; honours a client that opted out with `BRIGHTNESS=0`.                                                                                                                           |
| 9   | **Variables**            | Streams `VARIABLE-VALUE` for the output variables the client declared (clock, counter, random, long string); shows inbound `SET-VARIABLE-VALUE` in the UI.                                                                |
| 10  | **Device config**        | Renders the client's `CONFIG_FIELDS` as a real form in the web UI (same field schema Companion uses) and pushes `DEVICE-CONFIG` on change.                                                                                |
| 11  | **Subscriptions**        | For clients using `ADD-SUB`: a virtual page grid in the UI whose cells can be edited, streaming `SUB-STATE` to matching subscriptions.                                                                                    |
| 12  | **Attract / animation**  | A slow, pretty animation (plasma, marquee, clock) at a capped frame rate — for the demo video and for an unattended demo instance.                                                                              |
| 13  | **Stress**               | The bounded load tool (§8.3), presented as a scenario.                                                                                                                                                                    |

## 8. Web UI

### 8.1 Pages

- **Home** — what this is, the exact WebSocket URL to point a client at, and the claim-code entry
  box. Nothing else is listed publicly.
- **Session** — the working view, once claimed:
  - **Surface mirror**: the grid the server believes it sent, tile per control, showing the rendered
    bitmap (as a PNG data URL), colour swatches, text, font size, pressed state and LEDs, with a
    "last drawn" timestamp and a flash on update. _This is the alignment tool_ — put it next to the
    client's own screen and differences are obvious.
  - **Input log**: presses/rotations/pincode/variables from the client, with the resolved control and
    the raw parameters.
  - **Protocol trace**: bidirectional, timestamped, filterable, pausable; bitmap payloads elided as
    `BITMAP=<rgb 72×72 15552B>` with a click to expand; raw line and parsed params side by side;
    copy/export.
  - **Connection info**: transport, negotiated `CAPS`, decoded `ADD-DEVICE` params (pretty-printed
    manifest / config fields / variables), API version in force, `PING`/`PONG` RTT sparkline, byte
    and message counters, remaining rate-limit budget. Also the **received-only signals that produce
    no visible effect on the wire** — chiefly `FIRMWARE-UPDATE-INFO`'s `UPDATE_URL` (shown as inert
    text with its timestamp) and `CHANGE-PAGE` requests. Companion answers both with a bare `OK`, so
    this panel is the only way a client author can prove they were sent correctly.
  - **Sidebar**: scenario picker + per-scenario params, protocol profile, chaos panel, raw sender.
- **About / help** — protocol notes, links, version.

### 8.2 Protocol & version knobs

Because `BEGIN`/`CAPS` are sent at connect time, changing the advertised version can't apply to a
live connection. The UI therefore edits a **pending profile** and offers _Apply & bounce_ — which
sets the profile and then drops the connection so the client reconnects into it. (That doubles as a
reconnect test.)

Controls:

- Advertised `ApiVersion` — a dropdown of every real version (1.0.0 → 1.14.0) plus a free-text field.
- `CompanionVersion` string.
- `CAPS` toggles: `SUBSCRIPTIONS`, `NONSQUARE`, `ROTARY_AMOUNT`, and the `BITMAP_FORMATS` subset
  (none / `rgb` / `rgb,png` / `rgb,png,webp`).
- Wire quirks: trailing space on/off, `\r\n` vs `\n`.
- Because the capability profile gates the emitter, selecting 1.6.0 genuinely produces a 1.6.0-era
  server: no `LOCATION`, no `LEDS`, `ADD-SUB` rejected, rgb bitmaps only, ±1 rotation only.
- **Sticky per-device overrides**: keyed by device id, applied on the next connect. So a client can
  be pointed at the server and get the legacy behaviour before any claiming happens.
- **Optional convenience**: named profiles selectable in the URL, e.g.
  `wss://host/ws/satellite?profile=legacy-1.6`. Server-defined names only — never arbitrary values —
  so there is nothing to inject.

### 8.3 Connection chaos

All of these apply only to the session the acting browser has claimed, and all have hard ceilings.

- **Disconnect**: graceful close, abrupt `terminate()`, specific WebSocket close codes.
- **Refuse reconnects** for N seconds (≤120), in three flavours: reject the upgrade, accept then
  immediately close, accept and never send `BEGIN`.
- **Ping misbehaviour**: stop answering `PING`; answer late; answer with the wrong payload; stop
  sending server `PING`; a bounded `PING` burst.
- **Latency/jitter** on outbound (fixed or random range, ≤2 s) and on inbound processing.
- **Drop / duplicate / reorder** a percentage of outbound messages within a small window.
- **Framing games** — the highest-value WebSocket-specific tool: split one line across many frames
  (down to one byte per frame), or coalesce many lines into a single frame. A client that assumes
  frame == message fails here, and it's the bug most likely to reach production.
- **Oversized line**: emit a line near or over the client's plausible limit.
- **Idle timeout knob**: mirror Companion's 5 s, or shorten/lengthen/disable it.

### 8.4 Load / throughput (bounded)

> Caveat shown in the UI: this mostly measures the _server_ and the network, not the device — and
> the render cache means the server barely notices. Its real use is finding a client's decode and
> render ceiling, so it's built as a **payload sweep** rather than a raw flood.

Drive N controls at F fps for D seconds with a chosen bitmap size and format. Hard caps: F ≤ 30,
D ≤ 60, controls ≤ surface size, one stress run per session, a small number server-wide, and the
same per-connection byte budget as everything else. Auto-stops. Live throughput chart.

### 8.5 Raw sender

A composer for arbitrary protocol lines to the claimed session's client, with validation and a
preset library. It is the fastest way to reproduce an odd case, and it also covers most of the
deferred malformed-input tooling by hand. Length-capped (4 KB) and rate limited.

## 9. Security and abuse resistance

Threat model: anyone on the internet can open WebSocket connections and load the UI. The assets are
server CPU, memory, bandwidth, and the availability of the demo. Session _contents_ are explicitly
not protected.

### 9.1 The two structural properties

**No user-controlled egress.** The server never fetches a URL, resolves a hostname, or opens an
outbound connection on any user input. In particular `FIRMWARE-UPDATE-INFO`'s `UPDATE_URL` is stored
and displayed as inert, non-clickable text and never fetched. Enforce it as an invariant: no HTTP
client dependency in `packages/server`, and a lint rule/test asserting that.

**Relaying is confined to one session's two parties.** Data flows client → its own session → its
controller browser and back, and those two are on different IPs by design, so this _is_ a
cross-network relay of a limited kind — the trace carries what the client sent to the browser, and
the raw sender carries browser-composed lines to the client. It is not worth pretending otherwise.
What makes it unattractive rather than impossible: both ends must share a claim code, a session
carries no storage and dies minutes after disconnect, only one browser controls a session at a time,
and both directions sit under the size and rate caps in §9.2 (the raw sender is capped at 4 KB per
line and rate limited). Nothing a client sends ever reaches a _different_ session, so it cannot be
used as a broadcast relay, file drop or CDN. Anyone wanting a data channel between two hosts has far
better options; the mitigation here is the caps, not a claim of impossibility.

### 9.2 Limits

| Scope                              | Limit (default)                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Line length                        | 256 KB (Companion allows 2 MB; raisable via a knob for compatibility testing)                                                                                                                        |
| Inbound rate                       | 200 msg/s and 512 KB/s per connection, token bucket. Must comfortably fit the reference client's 10 Hz ping.                                                                                         |
| Devices per connection             | 4                                                                                                                                                                                                    |
| Subscriptions per connection       | 64                                                                                                                                                                                                   |
| Grid                               | `KEYS_TOTAL` ≤ 2000, `KEYS_PER_ROW` ≤ 1000 (mirrors upstream), but ≤ 512 _rendered_ controls                                                                                                         |
| Declared variables / config fields | 32 each                                                                                                                                                                                              |
| Decoded manifest / config JSON     | 256 KB before parse, schema-validated after                                                                                                                                                          |
| Bitmap request                     | ≤ 512×512, ≤ 4 MB/s of pixel output per session                                                                                                                                                      |
| Concurrent connections             | 5 per IP (IPv6 bucketed by /64), 500 server-wide                                                                                                                                                     |
| New connections                    | 30/min per IP, burst 10                                                                                                                                                                              |
| Claim attempts                     | 5/min per IP with backoff; constant-time compare; codes expire                                                                                                                                       |
| Outbound queue                     | Bounded bytes per connection; latest-wins coalescing per control (as Companion's `ImageWriteQueue` does); terminate on overflow rather than buffering                                                |
| Session lifetime                   | Idle disconnect 5 s (protocol); session GC 10 min after _both_ the client disconnects and the last controller unsubscribes; ≤4 held sessions per UI client; absolute session and connection cap 12 h |
| Trace buffer                       | 2000 lines/session, payloads elided                                                                                                                                                                  |

### 9.3 Web layer

- Two distinct WebSocket paths with different guards: `/ws/satellite` (native clients — **no**
  `Origin` check, they don't send one) and `/ws/trpc` (browser — `Origin` checked against the
  configured public origin).
- Strict CSP, `helmet`-style headers, no CORS, no cookies beyond an opaque UI client id, no uploads,
  small body limits, static assets served immutably.
- Every tRPC input validated with zod; mutations rate limited per UI client id _and_ per IP.
- Never `eval`, never build filesystem paths from input, `Object.create(null)` + banned prototype
  keys in the parser, base64 size-checked _before_ decode, JSON parsed under a size cap and then
  schema-validated.

### 9.4 Privacy on a shared instance

The public UI shows no list of other people's connections, no device ids and no IP addresses. IPs in
logs and in the admin view are shown hashed (`ip:ab12cd`). Full session detail requires the code.

### 9.5 Operations

- Structured logging (`pino`), payloads truncated, no bitmaps in logs.
- `/healthz` on the public listener — up/down only, no detail, since anyone can reach it.
- **Prometheus metrics on their own listener**, never the public one. Two independent defences,
  because one mistyped proxy rule should not expose operational internals:

  1. A separate port (`METRICS_PORT`, default 16625) bound to `METRICS_BIND` (default `127.0.0.1`;
     `0.0.0.0` under compose so a sidecar Prometheus on the same network can reach it). Nothing
     publishes it to the host, and the Caddyfile has **no route to it at all** — so there is no
     proxy rule to get wrong.
  2. An optional `METRICS_TOKEN`. When set, `/metrics` requires `Authorization: Bearer …` and answers
     **404** rather than 401 otherwise, so a prober cannot confirm the endpoint exists.

  Scraping from outside the host means exposing the port and setting the token; the Caddyfile carries
  a commented token-gated block for that. Blocking it at Caddy instead is equally fine — the separate
  port means the default is already closed either way.

  What to export (`prom-client`, plus its default process/GC collectors):

  | Metric                                         | Type      | Why                                           |
  | ---------------------------------------------- | --------- | --------------------------------------------- |
  | `satellite_connections{transport}`             | gauge     | current connections                           |
  | `satellite_connections_total{transport}`       | counter   | churn — reconnect storms show up here         |
  | `satellite_sessions{state}`                    | gauge     | unclaimed / claimed / orphaned                |
  | `satellite_messages_total{direction,command}`  | counter   | protocol mix; catches a client hot-looping    |
  | `satellite_bytes_total{direction}`             | counter   | bandwidth — the thing most worth alerting on  |
  | `satellite_render_duration_seconds{format}`    | histogram | the spike's numbers, in production            |
  | `satellite_render_cache_total{result}`         | counter   | hit/miss; cache health is the whole CPU story |
  | `satellite_rate_limit_rejections_total{limit}` | counter   | which cap is actually biting                  |
  | `satellite_claim_attempts_total{result}`       | counter   | brute-force attempts against claim codes      |
  | `satellite_scenario_active{scenario}`          | gauge     | what the demo instance is actually doing      |
  | `nodejs_eventloop_lag_seconds`                 | summary   | the canary for blocking encode work           |

- Optional `/admin` (token from env): global stats, kill a connection, temp-ban an IP, maintenance
  mode. Cheap insurance for a public instance.
- Container: non-root, read-only rootfs, no added capabilities, `--init`, memory/CPU limits,
  healthcheck. TLS, HTTP/2 and connection limits at the reverse proxy (Caddy); trusted-proxy hop
  count configured so `X-Forwarded-For` can't be spoofed.
- Minimal dependency surface; lockfile pinned; Dependabot.

## 10. Risks

- **`@napi-rs/canvas` in the image.** Needs the right libc and Node 26 prebuilds (N-API is
  ABI-stable, so this should be fine) — verify on the target architecture early, in Phase 0, not
  Phase 4.
- **Protocol drift.** Upstream will keep moving. Mitigation: keep `packages/protocol` a diffable
  port, pin the upstream commit in `docs/protocol.md`, and add a CI reminder job that flags when
  upstream's `API_VERSION` changes.
- **Ping rate vs rate limits.** The reference client pings at 10 Hz. Any limit tuning must be tested
  against a real client, not a synthetic one.
- **Unattended-demo dependency.** The demo must work with no interaction and survive a restart. In-memory
  state is fine because clients reconnect and rebuild, but the _instance_ must be up — so
  healthchecks, restart policy and a smoke test that connects a headless client are part of the deploy.

## 11. Deferred

TCP listener; the malformed/hostile-input tool suite (the raw sender covers most of it by hand);
persistence; session record/replay; multi-viewer sessions; i18n.
