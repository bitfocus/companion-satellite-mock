# Claiming and sessions

How a connected client becomes something you control from the web UI, and what survives a
reconnect.

## Why a claim code, not the device id

A client needs no configuration beyond a URL, and the mock has to work out which browser controls
which connection. Keying that on the device id would be simple, but device ids are long, hidden
inside the client app, and on a public server guessable: anyone could claim `streamdeck:1`.

So **the surface tells you its claim code by drawing it.**

1. The client connects and sends `ADD-DEVICE`.
2. The server creates a session and a six-character claim code from an unambiguous alphabet
   (Crockford base32, no `I`, `L`, `O` or `U`), shown as `K7M-2QP`.
3. The Unclaimed scenario draws an `UNCLAIMED` header key and the code, one character per key, or
   the whole code on one key if the surface is too small. Every key lights up while pressed, so the
   surface is visibly alive before anyone claims it.
4. You type the code into the web UI, and your browser now controls the session.
5. The surface switches to the Input echo scenario, which is the visible sign that the claim worked.

The code space is about 10^9, and guessing is rate limited per address and server-wide (see
[security.md](./security.md)). The client must have negotiated text or bitmaps to show the code;
see [scenarios.md](./scenarios.md).

## Sessions and reconnects

- A session belongs to one connection, and is keyed for continuity by its **primary device id**:
  the first `ADD-DEVICE` on that connection.
- A client that reconnects with the same primary device id gets the same session back: its claim,
  scenario, fault injection settings and trace. The surface does not bounce back to Unclaimed after
  a network flap, an app restart or a version change.
- This means **a client must keep its `DEVICEID` stable across reconnects.** One that makes up a new
  id each launch gets a new session and a new claim code every time.
- A session is collected 10 minutes (`SESSION_GRACE_MS`) after **both** ends are gone: the client
  has disconnected and no browser is watching. With the tab still open, a crashed client's session
  stays, shown as offline, which is what you want mid-debugging.
- Because an open tab can hold a session indefinitely, there are bounds: at most 4 claimed sessions
  per browser, and every session ends after 12 hours regardless.
- The claim code stays the same for the session's life. Unclaiming returns the surface to
  Unclaimed with a fresh code, so the old one stops working.
- Nothing is persisted. A server restart drops every session, and clients reconnect into fresh
  Unclaimed ones.
- Only one browser controls a session, and there is no public list of sessions: seeing a session's
  detail, including its trace, needs its code.

A connection may register several devices. The web UI currently shows only the primary one.

## A device id that is already in use

When two connections register the same device id, the mock deliberately differs from Companion by
default.

Companion sends `ADD-DEVICE ERROR … "Device exists elsewhere"` to the connection that **already
holds** the id, and sends the newcomer **nothing at all**, leaving it to time out. Against the mock
that would be a dead end: pairing needs a claim code drawn on the surface, so a client refused a
surface could never reach the web UI to find out why.

So by default the mock accepts the newcomer's registration without registering the device, and
draws the reason on its surface: `CAN'T PAIR`, `ID IN USE` and the id. The holder still gets its
error and keeps its device. The new surface can be drawn on but not driven: input naming that id is
refused like input for any unregistered device. The screen also explains Companion's real
behaviour.

Connect with `?duplicates=strict` to get Companion's behaviour exactly. That matters because the
silence happens in production: a client that reconnects before its previous socket has been
cleaned up hits exactly this case, and has to survive it.

One side effect: by default, a request that is both a duplicate and has a malformed
`LAYOUT_MANIFEST` reports the malformed layout, because a surface that can't be built has nowhere to
show the explanation. `strict` keeps Companion's order.
