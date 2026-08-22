# Security

This runs on the public internet, unauthenticated, by design. The threat model is therefore not
confidentiality — session contents are explicitly not secret — but **availability and abuse**: what
one bored visitor can do to everyone else's demo, and whether the server is useful to someone as a
tool for reaching a third party.

Full reasoning is in [design.md §9](./design.md#9-security-and-abuse-resistance). This is the
operator's summary.

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

| Limit                        | Default                            | Variable                                                   |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| Line length                  | 256 KB                             | `MAX_LINE_BYTES`                                           |
| WebSocket frame              | 1 MB                               | `MAX_FRAME_BYTES`                                          |
| Inbound rate                 | 200 msg/s, 512 KB/s per connection | `MAX_MESSAGES_PER_SECOND`, `MAX_BYTES_PER_SECOND`          |
| Concurrent connections       | 5 per IP, 500 total                | `MAX_CONNECTIONS_PER_IP`, `MAX_CONNECTIONS_TOTAL`          |
| New connections              | 30/min per IP, burst 10            | `CONNECTIONS_PER_IP_PER_MINUTE`, `CONNECTION_BURST_PER_IP` |
| Idle timeout                 | 5 s (matches Companion)            | `IDLE_TIMEOUT_MS`                                          |
| Connection lifetime          | 12 h                               | `MAX_CONNECTION_LIFETIME_MS`                               |
| Session grace                | 10 min after both ends are gone    | `SESSION_GRACE_MS`                                         |
| Devices per connection       | 4                                  | —                                                          |
| Subscriptions per connection | 64                                 | —                                                          |
| Rendered controls            | 512                                | —                                                          |
| Bitmap dimension             | 512 px, rejected not clamped       | —                                                          |
| Claim attempts               | 5/min per browser                  | —                                                          |

The frame cap and the line cap are separate on purpose: a line may arrive split across many frames,
and many lines may arrive coalesced into one, so tying them together disconnects a client that
batches its writes.

The inbound rate limits are tuned against the **reference client, which pings at 10 Hz** — not
against the spec's suggested 2 s interval, which would throttle every real client. There is a test
asserting a 10 Hz client is not throttled.

## Metrics

Prometheus metrics are on their own listener with **two independent defences**, because one mistyped
proxy rule should not expose operational internals:

1. `METRICS_BIND` defaults to `127.0.0.1`, and the reference Caddyfile has **no route to that port
   at all** — so the default is closed without depending on a proxy rule being right.
2. `METRICS_TOKEN`, when set, requires `Authorization: Bearer …` and answers **404** rather than 401,
   so a prober cannot confirm the endpoint exists.

## Trusted proxies

`TRUSTED_PROXY_HOPS` defaults to **0**, meaning `X-Forwarded-For` is ignored entirely and the socket
address is used. Set it to match your deployment exactly. Too high and a client can forge its own
address and walk straight through every per-IP limit.

IPv6 is bucketed by /64 — the smallest block routinely assigned to one subscriber. Per-address
limits on IPv6 are theatre.

## Privacy on a shared instance

The public UI lists nothing: no other people's sessions, device ids, or IP addresses. Full session
detail requires the claim code. IPs in logs are hashed with a per-process salt, so two connections
can be correlated within a run without the log becoming a record of who connected from where.

## Before going public

- Set `PUBLIC_ORIGIN` — the tRPC WebSocket only enforces its `Origin` check when one is configured.
- Set `TRUSTED_PROXY_HOPS` to match the deployment.
- Set `METRICS_TOKEN` if the container network is not trusted.
- Run a soak test. This is the one hardening item deliberately not done — it needs an hour of wall
  clock to mean anything.
