# TODO

## Features

- **Device switcher.** A connection can register several devices, but the web UI only ever shows
  the first one (the session's primary device). Let the operator pick which device the Surface,
  Device and scenario controls apply to.
- **Diagnostics panel.** Things a client author wants to confirm and currently can't see:
  - ping round-trip time over time, not just keepalive counts;
  - the `CAPS` line as negotiated for this connection, decoded;
  - `CHANGE-PAGE` requests the client sent.
- **More fault injection** (Network tab):
  - an adjustable idle timeout per session, rather than only the `IDLE_TIMEOUT_MS` env var;
  - oversized lines, near or over the client's plausible limit;
  - reordered messages.
- **`NONSQUARE=0` padding.** When a client doesn't negotiate non-square bitmaps, Companion pads a
  non-square button image to square. The mock renders at the requested size and never pads.
