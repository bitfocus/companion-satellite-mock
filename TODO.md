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

## Protocol package

- **Switch to `@companion-app/satellite-protocol`** for what it now covers: the line parser,
  message formatter, upstream schemas, constants and feature table. Keep `packages/protocol` as a
  thin layer for what is mock-specific (outbound message builders, surface model, version
  profiles, config values). Pin `~0.1.x` while it is pre-1.0, and run its conformance corpus
  against the server. Once done, the Bitfocus notice in `LICENSE`, `docs/upstream.md` and
  `docs/shared-package-proposal.md` can go or be cut down.

## Docs

- **README:**
  - document the client URL options: `?api=`, `?subs=0`, `?formats=`, `?duplicates=strict`;
  - add an environment variable reference;
  - list `yarn dev`, `yarn dev:ui`, `yarn test:e2e` and `yarn smoke`;
  - mention the published image on ghcr.io, the MIT licence, and how to contribute.
- **docs/protocol.md:**
  - replace "Apply & bounce" with the Disconnect action on the Network tab;
  - fix `MAX_LINE_LENGTH` → `UPSTREAM_MAX_LINE_LENGTH` and `ApiVersionProfile` → `capabilitiesFor()`;
  - list known differences from Companion: no `NONSQUARE=0` padding (until the feature above), and
    `VARIABLE-VALUE` is not debounced.
- **docs/security.md:** not every limit has a test in `abuse.test.ts`, so stop saying so, and
  reword the soak-test note as advice to operators.

## Small fixes

- The raw line placeholder `KEYS-CLEAR DEVICEID="dev1"` contains quotes, which the server refuses.
- Comments in `render/budget.ts` repeat the disproven claim that PNG encoding blocks the event loop.
- `TracePanel.tsx` says keepalives are shown "in the sidebar"; they're on the Device tab.
