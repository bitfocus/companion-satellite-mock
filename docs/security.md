# Security

This runs on the public internet, unauthenticated, by design. The threat model is therefore not
confidentiality — session contents are explicitly not secret — but **availability and abuse**: what
one bored visitor can do to everyone else's demo, and whether the server is useful to someone as a
tool for reaching a third party.

## The two structural properties

**No user-controlled egress.** The server never fetches a URL, resolves a hostname, or opens an
outbound connection on any input. `FIRMWARE-UPDATE-INFO`'s `UPDATE_URL` — the one user-supplied URL
the protocol carries — is stored and displayed as inert, non-clickable text and never fetched. This
is enforced by lint, not by review: `packages/server` may not use `fetch` or import an HTTP client,
and the rule is verified to fire.

**Relaying is confined to one session's two parties.** A session's client and its controlling
browser are on different networks by design, so this _is_ a cross-network relay of a limited kind —
worth stating plainly rather than denying. What makes it unattractive: both ends must share a claim
code, a session carries no storage and dies minutes after disconnect, only one browser controls a
session at a time, and both directions are size- and rate-capped. Nothing crosses into another
session, so it cannot be a broadcast relay, file drop or CDN.

## Limits

Every one of these has a test that drives it until it fires (`packages/server/src/abuse.test.ts`).
All are configurable by environment variable.

| Limit                        | Default                                     | Variable                                                   |
| ---------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Line length                  | 256 KB                                      | `MAX_LINE_BYTES`                                           |
| WebSocket frame              | 1 MB                                        | `MAX_FRAME_BYTES`                                          |
| Inbound rate                 | 200 msg/s, 512 KB/s per connection          | `MAX_MESSAGES_PER_SECOND`, `MAX_BYTES_PER_SECOND`          |
| Concurrent connections       | 5 per IP, 500 total                         | `MAX_CONNECTIONS_PER_IP`, `MAX_CONNECTIONS_TOTAL`          |
| New connections              | 30/min per IP, burst 10                     | `CONNECTIONS_PER_IP_PER_MINUTE`, `CONNECTION_BURST_PER_IP` |
| Idle timeout                 | 5 s (matches Companion)                     | `IDLE_TIMEOUT_MS`                                          |
| Connection lifetime          | 12 h                                        | `MAX_CONNECTION_LIFETIME_MS`                               |
| Session grace                | 10 min after both ends are gone             | `SESSION_GRACE_MS`                                         |
| Devices per connection       | 4                                           | —                                                          |
| Subscriptions per connection | 64                                          | —                                                          |
| Rendered controls            | 512                                         | —                                                          |
| Bitmap dimension             | 512 px, rejected not clamped                | —                                                          |
| Claim attempts               | 10/min per IP; 120 failures/min server-wide | —                                                          |
| Web UI actions               | 10/s per IP, burst 60                       | —                                                          |
| Web UI sockets               | 16 per IP, 1000 total; 64 KB per message    | —                                                          |
| Rendered text                | 200 characters, 8 lines                     | —                                                          |
| Reconnect blackout           | 60 s, self-expiring                         | —                                                          |

Nothing the satellite client sends is executed or used to make a request. In particular, a
`textinput` field's declared `regex` is enforced only in the browser, never on the server: the
pattern comes from the client and the value from the web UI, and on a public server one person
controls both, so a backtracking pattern would otherwise hold the event loop for every session.
Client-supplied text that a scenario draws (variable names, control ids) is cut to 200 characters
before layout, because laying out a 256 KB line took over a second.

The frame cap and the line cap are separate on purpose: a line may arrive split across many frames,
and many lines may arrive coalesced into one, so tying them together disconnects a client that
batches its writes.

The reconnect blackout is the one tool here that _refuses_ traffic rather than bounding it, so it
gets an extra note. It exists so a client's backoff can be tested, and it is deliberately not
addressable: the API takes no address, only a session, and applies the blackout to whatever address
that session's own connection is coming from. Holding the claim code for a session means being the
client on the other end of it, so the only address an operator can hold out is their own. It is
capped at a minute, expires on its own, can be cleared early, and is keyed by `normaliseIp` so a
routed IPv6 prefix is not a way to walk straight back in.

The inbound rate limits are tuned against the **reference client, which pings at 10 Hz** — not
against the spec's suggested 2 s interval, which would throttle every real client. There is a test
asserting a 10 Hz client is not throttled.

## Web layer

- Two WebSocket paths with different guards. `/ws/satellite` is for native clients and checks no
  `Origin`, because they send none. `/ws/trpc` is for the browser and only accepts the configured
  `PUBLIC_ORIGIN`. They are separate listeners on separate ports, so one set of guards can't be
  wrong for the other.
- A strict CSP plus `nosniff`, `no-referrer` and frame-denial headers. No CORS, no cookies and no
  uploads. The browser's id lives in `localStorage` and only scopes sessions; it authorises nothing.
- Every tRPC input is validated with zod, and mutations are rate limited per IP — never per browser
  id, because the browser chooses it.
- The parser builds prototype-less objects and drops prototype keys; base64 is size-checked before
  decoding; JSON is parsed under a size cap and then schema-validated. Nothing evaluates input or
  builds a file path from it.

## Metrics

Prometheus metrics are on their own listener with **two independent defences**, because one mistyped
proxy rule should not expose operational internals:

1. `METRICS_BIND` defaults to `127.0.0.1`, and it is a separate port from the UI, so a reverse proxy
   needs no rule to keep it private: give it no route at all.
2. `METRICS_TOKEN`, when set, requires `Authorization: Bearer …` and answers **404** rather than 401,
   so a prober cannot confirm the endpoint exists.

## Trusted proxies

`TRUSTED_PROXY_HOPS` defaults to **0**, meaning `X-Forwarded-For` is ignored entirely and the socket
address is used. Set it to match your deployment exactly. Too high and a client can forge its own
address and walk straight through every per-IP limit.

IPv6 is bucketed by /64 — the smallest block routinely assigned to one subscriber. Per-address
limits on IPv6 are theatre.

## Privacy on a shared instance

The public UI lists nothing: no other people's sessions, device ids, or IP addresses — not even
hashed ones. Full session detail requires the claim code, and no API returns an address.

**Server logs are different, deliberately.** They record the real client address by default, because
the hashed form cannot answer the question an operator actually has after an incident: was this the
same address as last week? The salt is per-process, so it changes on every restart and correlation
dies with it. Each line therefore carries both — `ip` (hashed, stable within a run, safe to quote
anywhere) and `clientIp` (the address itself).

Set `LOG_CLIENT_IPS=0` to drop `clientIp`; the hash and all correlation within a run survive. Note
that addresses are personal data in most jurisdictions, so whatever ships or stores these logs wants
a retention policy — this server keeps nothing on disk itself.

What is recorded, and why it is the useful set for chasing abuse:

| Event                  | Fields                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| connection refused     | address, refusal reason, user-agent, forwarded-for chain                 |
| connection opened      | address, connection id, user-agent, negotiated API version               |
| connection closed      | duration, bytes in/out, messages in, devices registered                  |
| blackout started       | address, duration                                                        |
| limit trips, bad lines | inherited from the connection's logger, so they carry its address and id |

The forwarded-for chain is logged only when `TRUSTED_PROXY_HOPS` is set, since it is attacker-
controlled otherwise and would be a way to write arbitrary strings into the log.

## Before going public

- Set `PUBLIC_ORIGIN` — the tRPC WebSocket only enforces its `Origin` check when one is configured.
- Set `TRUSTED_PROXY_HOPS` to match the deployment.
- Set `METRICS_TOKEN` if the container network is not trusted.
- Run a soak test. This is the one hardening item deliberately not done — it needs an hour of wall
  clock to mean anything.
