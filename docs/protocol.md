# Satellite API — implementation notes

**The spec is [companion.free/for-developers/Satellite-API](https://companion.free/for-developers/Satellite-API)**
(source: [`bitfocus/website/for-developers/Satellite-API.md`](https://github.com/bitfocus/website/blob/main/for-developers/Satellite-API.md)).
It is current, complete and covers API 1.14. Read it for the protocol; do not duplicate it here.

This file holds only what the spec reasonably leaves out but a _server_ reimplementation must match:
wire quirks, exact bounds, exact error strings, liveness timing, and the version→capability matrix
the mock's version knob is built on. Read out of the Companion source at commit
[`3d76cba`](https://github.com/bitfocus/companion/commit/3d76cbadedab21d5dc7e14d3b332557248513b1a)
(2026-08-21):

- `companion/lib/Service/Satellite/SatelliteApi.ts` — dispatch, handshake, validation
- `companion/lib/Service/Satellite/SatelliteRenderUtil.ts` — style/bitmap args
- `companion/lib/Surface/IP/Satellite.ts` — outbound message construction
- `companion/lib/Service/SatelliteTcp.ts` / `SatelliteWebsocket.ts` — transports, timeouts
- `companion/lib/Resources/Util.ts` — `parseLineParameters`, `isTruthy`, `isFalsey`

The JSON schemas are published as assets and should be consumed directly rather than retyped:
[`satellite-surface.schema.json`](https://github.com/bitfocus/companion/blob/main/assets/satellite-surface.schema.json)
and [`satellite-config-fields.schema.json`](https://github.com/bitfocus/companion/blob/main/assets/satellite-config-fields.schema.json).

**Acceptance criterion for the mock's protocol layer is "matches upstream source", not "matches this
file".** Re-pin the commit whenever this is refreshed.

---

## 1. Wire quirks

Each of these is a test case in `packages/protocol`.

1. **Trailing space before the newline on every emitted line.** `sendMessage` joins its chunks with
   `' '` and pushes `'\n'` as the final chunk, so Companion emits `KEY-STATE DEVICEID="x" KEY=0 \n`.
2. **Only the first `\r` is stripped** from an inbound line (`line.replace(/\r/, '')`, no `g` flag).
3. **`=` splits on the first occurrence only** — the remainder is the value. (Fixed upstream in 2026;
   a `split('=', 2)` corrupts base64 padding and `data:` URLs.)
4. **Quotes are stripped anywhere in a fragment**, not just at the ends: `KEY="1"2` → `12`.
5. **`\` escapes the following character** verbatim, wherever it appears.
6. **A fragment with no `=` becomes `true`** (a bare flag).
7. **Booleans are always emitted as `1`/`0`**, and accepted as `true`/`false`/`1`/`0`.
8. **`PING`'s payload is the raw unparsed remainder of the line**, echoed as-is into `PONG`.
9. **`Device exists elsewhere` is sent to the _existing_ socket**, not to the one that asked. The
   requesting socket gets no reply at all.
10. **`Line too long` is emitted as `ERROR ERROR MESSAGE="Line too long"`** — `messageName` is
    `'ERROR'` _and_ the status is `'ERROR'`.
11. **`BITMAPS=1`, any non-numeric truthy value, or a number `<5` all mean 72 px.**
12. **`FONT_SIZE` may be the literal string `auto`**, not just a number.
13. **`LEDS` ignores the negotiated `BITMAP_FORMAT`** — always raw RGB, never a data URL.
14. **`DIRECTION=0` means −1**, not 0.
15. **Command names are matched case-insensitively** (`cmd.toUpperCase()`); parameter keys are not.
16. **Outbound values are not escaped.** Companion wraps strings in `"` and relies on callers never
    putting a `"` or newline into a value. The mock must be equally careful — and its raw sender is
    where a malformed line would come from.
17. **Parsed params live on a null-prototype object** and keys in `BANNED_PROPS` (`__proto__` and
    friends) are dropped — a prototype-pollution guard worth keeping.

## 2. Bounds

| Thing                     | Upstream value                                             | Constant           |
| ------------------------- | ---------------------------------------------------------- | ------------------ |
| Receive buffer / max line | 2 MB, then `Line too long` + destroy                       | `MAX_LINE_LENGTH`  |
| `KEYS_TOTAL`              | 1 … 2000                                                   | `MAX_KEYS_TOTAL`   |
| `KEYS_PER_ROW`            | 1 … 1000                                                   | `MAX_KEYS_PER_ROW` |
| `SUBID` charset           | `/^[a-zA-Z0-9\-/]+$/`                                      | —                  |
| Control id charset        | `/^[a-zA-Z0-9\-/]+$/`                                      | —                  |
| `LOCATION`                | `/^(\d+)\/(\d+)\/(\d+)$/`                                  | —                  |
| `PINCODE-KEY` `KEY`       | 0 … 9                                                      | —                  |
| LED `segments`            | 1 … 200                                                    | schema             |
| Reserved id prefixes      | `emulator:`, `group:` rejected for `DEVICEID` and `SERIAL` | —                  |

The mock deliberately tightens some of these (see [design.md §9.2](./design.md#92-limits)) with a
knob to restore upstream values for compatibility testing.

## 3. Error strings

Stable, and worth asserting on verbatim:

`Missing DEVICEID` · `Missing PRODUCT_NAME` · `Reserved DEVICEID` · `Reserved SERIAL` ·
`Device already added` · `Device exists elsewhere` · `Invalid LAYOUT_MANIFEST` · `Invalid KEYS_TOTAL` ·
`Invalid KEYS_PER_ROW` · `Invalid VARIABLES` · `Invalid CONFIG_FIELDS` · `Device not found` ·
`Missing KEY` · `Invalid KEY` · `Missing PRESSED` · `Missing CONTROLID` · `Unknown CONTROLID` ·
`Missing DIRECTION` · `Missing VARIABLE` · `Missing VALUE` · `Missing UPDATE_URL` ·
`Subscriptions not enabled` · `Missing SUBID` · `Invalid SUBID` · `SUBID already in use` ·
`Unknown SUBID` · `Missing LOCATION` · `Invalid LOCATION` · `Invalid STYLE` · `Line too long` ·
`Unknown command: X`

## 4. Liveness

|                                | Value                                                        |
| ------------------------------ | ------------------------------------------------------------ |
| TCP idle timeout               | `socket.setTimeout(5000)` → `destroy()`                      |
| WebSocket idle timeout         | 3 s interval, `terminate()` if >5 s since last inbound frame |
| Reference client ping interval | **100 ms**                                                   |
| Reference client tolerance     | 15 unacked pings, with a 1 s "recently heard from" allowance |

The spec recommends pinging every 2 s; the real client pings at 10 Hz. **Rate limits must be tuned
against the real client, not the recommendation.**

The WebSocket transport is _not_ message-per-frame: Companion appends frame text to a receive buffer
and splits on `\n`. Companion happens to write one line per frame, but that is not a guarantee — which
is exactly why the mock's framing chaos tool (split/coalesce) is high value.

## 5. Behaviours the spec states loosely

- **`CAPS` exists only from 1.10.0.** Per the spec, clients should decide whether a feature _exists_
  from `ApiVersion`, and consult `CAPS` only for features that may be conditionally disabled within a
  version that supports them. The mock's version profiles must honour that split.
- **Toggling a capability closes connections.** Upstream force-closes every satellite socket when
  `satellite_subscriptions_enabled` changes, so clients reconnect and re-read `CAPS`. The mock's
  _Apply & bounce_ does the same thing and is therefore realistic, not a contrivance.
- **`DEVICE-CONFIG` is pushed once immediately after `ADD-DEVICE OK`** (when `CONFIG_FIELDS` were
  declared), then again on every change.
- **`VARIABLE-VALUE` is debounced** upstream (5 ms, max 20 ms) and only sent when the value actually
  changed.
- **Subscribing to an empty location is valid** — `OK`, then a `SUB-STATE` for an empty button.
- **`LOCATION` is sent for all button types but is not always known**, so it is genuinely optional.
- **`NONSQUARE=0` does not forbid non-square controls** in advanced layouts; it means Companion pads
  to square with black borders. The mock should reproduce the padding, not reject the layout.
- **`full-ring` LED mode falls back to `simple`** when the button's gauge is not actually a ring, and
  deadzone segments are black. An absent `LEDS` field means "all off", not "unchanged".
- **`CHANGE-PAGE` is silently ignored** when the user has disabled page changes for the surface —
  Companion always answers `OK`.
- **`FIRMWARE-UPDATE-INFO` produces nothing on the wire but the `OK`.** Companion just shows an
  indicator in its own UI. The mock's web UI is therefore the _only_ place a client author can
  confirm it was sent correctly, so it must be reported there prominently.

## 6. Version → capability matrix

Drives `ApiVersionProfile` and the version knob. Companion-version column is from the spec.

| API    | Companion | Gate this in the profile                                                                                                                                 |
| ------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0.0  | —         | baseline                                                                                                                                                 |
| 1.1.0  | —         | `KEY-STATE` gains `TYPE`, `PRESSED`                                                                                                                      |
| 1.2.0  | —         | `DEVICEID` included on errors                                                                                                                            |
| 1.3.0  | —         | `KEY-ROTATE` accepted                                                                                                                                    |
| 1.4.0  | v3.0+     | `TEXT_STYLE` flag, `FONT_SIZE` arg                                                                                                                       |
| 1.5.0  | v3.2+     | `BITMAPS` as a pixel size                                                                                                                                |
| 1.5.1  | —         | grid size limits lifted                                                                                                                                  |
| 1.6.0  | —         | `row/column` key notation; `TEXTCOLOR`; `COLORS` format choice; >32 keys                                                                                 |
| 1.7.0  | v3.4+     | `VARIABLES`/`SET-VARIABLE-VALUE`/`VARIABLE-VALUE`; `BRIGHTNESS` opt-out                                                                                  |
| 1.7.1  | —         | `VARIABLE` echoed in the `SET-VARIABLE-VALUE OK`                                                                                                         |
| 1.8.0  | v4.0+     | `PINCODE_LOCK`, `PINCODE-KEY`, `LOCKED-STATE`                                                                                                            |
| 1.9.0  | v4.2+     | `LAYOUT_MANIFEST`, `CONTROLID` addressing                                                                                                                |
| 1.10.0 | v4.3+     | `CAPS`; subscriptions; `LOCATION`; `SERIAL`/`SERIAL_IS_UNIQUE`; `CONFIG_FIELDS`/`DEVICE-CONFIG`; `CAN_CHANGE_PAGE`/`CHANGE-PAGE`; `FIRMWARE-UPDATE-INFO` |
| 1.10.1 | —         | `ROTATION` on `LOCKED-STATE`                                                                                                                             |
| 1.11.0 | v5.0+     | `NONSQUARE` in `CAPS`                                                                                                                                    |
| 1.12.0 | v5.0+     | `BITMAP_FORMATS` in `CAPS`, `BITMAP_FORMAT` on `ADD-DEVICE`/`ADD-SUB`                                                                                    |
| 1.13.0 | v5.1+     | `leds` style preset, `LEDS` arg (no `CAPS` flag — gated on `ApiVersion` alone)                                                                           |
| 1.14.0 | v5.1+     | signed multi-step `DIRECTION`, `ROTARY_AMOUNT` in `CAPS`                                                                                                 |

Selecting an API version in the UI must therefore change real behaviour: at 1.6.0 the mock sends no
`CAPS` at all, no `LOCATION`, no `LEDS`, rejects `ADD-SUB`, streams `rgb` only, and clamps rotation
to ±1.
