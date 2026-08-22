# Satellite API — working reference (API 1.14.0)

> **Why this file exists.** The public wiki page
> ([bitfocus/companion wiki: Satellite-API](https://github.com/bitfocus/companion/wiki/Satellite-API))
> documents up to API **1.8.0** and is missing a lot. Everything below was read out of the
> Companion source at commit
> [`3d76cba`](https://github.com/bitfocus/companion/commit/3d76cbadedab21d5dc7e14d3b332557248513b1a)
> (2026-08-21), primarily:
>
> - `companion/lib/Service/Satellite/SatelliteApi.ts` — command handling, handshake, validation
> - `companion/lib/Service/Satellite/SatelliteRenderUtil.ts` — style/bitmap argument building
> - `companion/lib/Service/Satellite/SatelliteSurfaceManifestSchema.ts` — advanced layout schema
> - `companion/lib/Service/Satellite/SatelliteConfigFieldsSchema.ts` — `CONFIG_FIELDS` schema
> - `companion/lib/Surface/IP/Satellite.ts` — outbound message construction
> - `companion/lib/Service/SatelliteTcp.ts` / `SatelliteWebsocket.ts` — transports
> - `companion/lib/Resources/Util.ts` — `parseLineParameters`, `isTruthy`, `isFalsey`
>
> **This is a moving target.** Pin the upstream commit whenever this file is refreshed, and treat
> "matches upstream source" as the acceptance criterion for the mock's protocol layer, not
> "matches this file".

---

## 1. Transports

| Transport  | Default port | Notes |
|------------|--------------|-------|
| TCP        | 16622        | Raw line-oriented stream. |
| WebSocket  | 16623        | Added in Companion 3.5. Text frames; `ws://host:16623/` with no path convention. |

Both feed the *same* line-based protocol engine. The WebSocket transport is **not** a
message-per-frame protocol: Companion appends every received frame's text into a receive buffer and
splits on `\n`. A client must not assume one frame == one message. Companion's own writes happen to
be one line per frame, but that is an implementation detail, not a guarantee.

Idle handling:

- **TCP**: `socket.setTimeout(5000)` → destroy on 5s of no inbound data.
- **WebSocket**: a 3s interval checks `lastReceived`; `terminate()` if >5s stale.
- The reference client (`companion-satellite`) sends `PING` every **100 ms**, tolerates 15 unacked
  pings, and treats 1s of silence as suspicious. Any mock must survive a 10 Hz ping stream.

## 2. Line format

```
COMMAND-NAME ARG1=VAL1 ARG2=true ARG3="VAL3 with spaces"\n
```

- Terminator `\n`; a single `\r` is stripped (`line.replace(/\r/, '')` — note: only the *first* one).
- Parsing is done by `parseLineParameters`, which has behaviours worth reproducing exactly:
  - `\` escapes the next character verbatim (so `\"` is a literal quote).
  - `"` toggles quoting state; quotes are *removed* and may appear anywhere in a fragment
    (`KEY="1"2` parses to `12`).
  - Fragments split on unquoted spaces; empty fragments are skipped, so runs of spaces are harmless.
  - Split on the **first** `=` only — the remainder is the value. (Fixed in 2026 so base64 `=`
    padding and `data:` URLs survive.)
  - A fragment with no `=` becomes `key: true` (a bare flag).
  - Keys in `BANNED_PROPS` (prototype-pollution guards) are dropped; the result object is
    `Object.create(null)`.
- Booleans: accepted as `true`/`false`/`1`/`0` (`isTruthy`/`isFalsey`); always **emitted** as `1`/`0`.
- Outbound serialisation (`SatelliteSocketWrapper.sendMessage`) joins chunks with `' '` and pushes
  `'\n'` as the final chunk — so **every line Companion emits ends with a space before the newline**
  (`KEY-STATE DEVICEID="x" KEY=0 \n`). Reproduce this quirk by default; a real client must tolerate it.
- Strings are emitted wrapped in `"`, numbers and booleans bare. There is **no escaping on output** —
  Companion relies on callers not putting `"` or newlines into values.

## 3. Handshake

On connect the server immediately sends, in order:

```
BEGIN CompanionVersion="<appBuild>" ApiVersion="1.14.0"
CAPS SUBSCRIPTIONS=0|1 NONSQUARE=1 BITMAP_FORMATS="rgb,png,webp" ROTARY_AMOUNT=1
```

- `CompanionVersion` is informational only.
- `ApiVersion` is semver; clients gate features on it.
- `CAPS` (added alongside 1.10/1.11/1.12/1.14 features) advertises optional server capabilities:
  - `SUBSCRIPTIONS` — whether `ADD-SUB` etc. are enabled (a Companion user-config toggle; flipping it
    force-closes all satellite connections so clients re-read `CAPS`).
  - `NONSQUARE` — server can produce non-square button bitmaps (1.11.0).
  - `BITMAP_FORMATS` — comma-separated list of encodings the server can produce (1.12.0).
  - `ROTARY_AMOUNT` — server understands a signed multi-step `DIRECTION` (1.14.0).

## 4. Response conventions

- Unknown command → `ERROR MESSAGE="Unknown command: SOMETHING"`
- Per-command results → `COMMAND-NAME OK [DEVICEID="…"] [ARG=…]` or
  `COMMAND-NAME ERROR [DEVICEID="…"] MESSAGE="…"`
- `DEVICEID` is included in errors whenever it is known (since 1.2.0).
- Error message strings are stable and worth matching verbatim — the mock's compatibility tests
  assert on them. Full list observed in 1.14.0:
  `Missing DEVICEID`, `Missing PRODUCT_NAME`, `Reserved DEVICEID`, `Reserved SERIAL`,
  `Device already added`, `Device exists elsewhere`, `Invalid LAYOUT_MANIFEST`, `Invalid KEYS_TOTAL`,
  `Invalid KEYS_PER_ROW`, `Invalid VARIABLES`, `Invalid CONFIG_FIELDS`, `Device not found`,
  `Missing KEY`, `Invalid KEY`, `Missing PRESSED`, `Missing CONTROLID`, `Unknown CONTROLID`,
  `Missing DIRECTION`, `Missing VARIABLE`, `Missing VALUE`, `Missing UPDATE_URL`,
  `Subscriptions not enabled`, `Missing SUBID`, `Invalid SUBID`, `SUBID already in use`,
  `Unknown SUBID`, `Missing LOCATION`, `Invalid LOCATION`, `Invalid STYLE`, `Line too long`.

## 5. Client → server commands

### `ADD-DEVICE`

Registers a surface. One connection may register several devices.

Required: `DEVICEID`, `PRODUCT_NAME`.

| Param | Since | Meaning |
|---|---|---|
| `DEVICEID` | 1.0 | Unique id; convention `type:serial`, e.g. `streamdeck:12345`. Rejected if it starts with `emulator:` or `group:`. |
| `PRODUCT_NAME` | 1.0 | Display name in the Surfaces table. |
| `SERIAL` | — | Optional; defaults to `DEVICEID`. Same reserved-prefix rules. |
| `SERIAL_IS_UNIQUE` | — | Boolean, default true. |
| `KEYS_TOTAL` | 1.0 | Legacy grid size. Default 32. `1..2000` (`MAX_KEYS_TOTAL`). |
| `KEYS_PER_ROW` | 1.0 | Legacy row width. Default 8. `1..1000` (`MAX_KEYS_PER_ROW`). |
| `BITMAPS` | 1.5 | Desired bitmap edge in px. Falsey → no bitmaps. Numeric `<5` or non-numeric truthy → 72. |
| `COLORS` | 1.6 | `true`/`hex`/`rgb`/false. `hex` → `#rrggbb`, `rgb` → `rgb(r,g,b)` (no spaces). |
| `TEXT` | 1.0 | Stream button text. |
| `TEXT_STYLE` | 1.4 | Stream `FONT_SIZE`. |
| `BRIGHTNESS` | 1.7 | Default true. False → no `BRIGHTNESS` messages and no slider in the UI. |
| `VARIABLES` | 1.7 | base64 JSON array of `{id, type: 'input'\|'output', name, description?}`. |
| `PINCODE_LOCK` | 1.8 | `FULL` or `PARTIAL` — client renders the locked state itself. Any other value ⇒ unsupported. |
| `LAYOUT_MANIFEST` | 1.9 | base64 JSON "advanced mode" layout (see §7). Supersedes `KEYS_*`/`BITMAPS`/`COLORS`/`TEXT`/`TEXT_STYLE`. |
| `CONFIG_FIELDS` | 1.10 | base64 JSON array of config field definitions rendered in Companion's surface settings (see §8). |
| `CAN_CHANGE_PAGE` | 1.10 | Non-empty string ⇒ surface can request page changes. |
| `BITMAP_FORMAT` | 1.12 | `rgb` \| `png` \| `webp`. Unknown/absent ⇒ `rgb`. |

Grid size in advanced mode is derived from the max row/column across `controls`.

Duplicate registration: if the device id already exists on **this** socket →
`Device already added` to this socket; if on **another** socket → `Device exists elsewhere` is sent
to the *existing* socket (a deliberate quirk — the new socket gets no reply).

### `REMOVE-DEVICE DEVICEID=…`
Removes the surface. `Device not found` if unknown or owned by another socket.

### `KEY-PRESS DEVICEID=… (KEY=… | CONTROLID=…) PRESSED=…`
`CONTROLID` in advanced mode, `KEY` in legacy mode. `KEY` accepts a flat index **or** `row/column`
notation (since 1.6).

### `KEY-ROTATE DEVICEID=… (KEY=… | CONTROLID=…) DIRECTION=…`
Since 1.14, `DIRECTION` is a signed step count (sign = direction, magnitude = steps). `0` means one
counter-clockwise step for backwards compatibility. Non-numeric falls back to "≥`1` means clockwise".

### `SET-VARIABLE-VALUE DEVICEID=… VARIABLE=<id> VALUE=<base64>`
Value is base64 so newlines/quotes are safe. Success echoes `VARIABLE` (since 1.7.1).

### `PINCODE-KEY DEVICEID=… KEY=0..9`
Only meaningful when `PINCODE_LOCK` was requested.

### `FIRMWARE-UPDATE-INFO DEVICEID=… UPDATE_URL=…` (1.10)
Reports that a firmware update is available; empty string clears it. Companion stores and surfaces
the URL. **The mock must never fetch this URL.**

### `CHANGE-PAGE DEVICEID=… DIRECTION=…` (1.10)
Truthy `DIRECTION` = forwards.

### Subscriptions (1.10) — `ADD-SUB` / `REMOVE-SUB` / `SUB-PRESS` / `SUB-ROTATE`
Connection-scoped (not device-scoped) views of a single button location, independent of any surface.
All four are rejected with `Subscriptions not enabled` unless the server advertises
`CAPS SUBSCRIPTIONS=1`.

- `ADD-SUB SUBID=<[a-zA-Z0-9-/]+> LOCATION=<page>/<row>/<column> [STYLE=<base64 json>] [BITMAP=…] [COLORS=…] [TEXT=…] [TEXT_STYLE=…] [BITMAP_FORMAT=…]`
  `STYLE` (base64 of a style preset object) takes precedence; otherwise the legacy flags build one.
  On success the current render is pushed immediately as `SUB-STATE`.
- `REMOVE-SUB SUBID=…`
- `SUB-PRESS SUBID=… PRESSED=…`, `SUB-ROTATE SUBID=… DIRECTION=…` — same rotation semantics as above.

### `PING <payload>` / `PONG <payload>` / `QUIT`
`PING` is echoed as `PONG <payload>` (the payload is the raw remainder of the line, unparsed).
Inbound `PONG` is ignored. `QUIT` destroys the socket.

### Line length
The receive buffer is capped at `MAX_LINE_LENGTH` = **2 MB**. Exceeding it sends
`ERROR ERROR MESSAGE="Line too long"` (note the doubled token — `messageName` is `'ERROR'` *and*
status is `'ERROR'`) and destroys the socket.

## 6. Server → client messages

### `KEY-STATE DEVICEID=… (KEY=<index> | CONTROLID=<id>) [LOCATION=p/r/c] <style args>`
Sent per control whenever it redraws. `LOCATION` is included whenever known (since 1.10).

Style args (`buildSatelliteStyleArgs`), each present only if the control's style preset asked for it:

| Arg | Content |
|---|---|
| `PRESSED` | `0`/`1` — always sent. |
| `TYPE` | `BUTTON` \| `PAGEUP` \| `PAGEDOWN` \| `PAGENUM` — always sent. |
| `BITMAP` | `rgb`: bare base64 of raw 8-bit RGB, `w*h*3` bytes. `png`/`webp`: a full `data:image/png;base64,…` URL, sent verbatim. The `data:` prefix is how a client tells them apart. |
| `COLOR` | Background colour, `#rrggbb` or `rgb(r,g,b)` per the negotiated format. |
| `TEXTCOLOR` | Text colour, same format (since 1.6). |
| `TEXT` | base64 of the button text. |
| `FONT_SIZE` | Number, or the literal string `auto`. |
| `LEDS` | base64 of packed RGB, one triple per segment. **Always raw RGB**, never the negotiated bitmap format (1.13). |

### `SUB-STATE SUBID=… <style args>`
Same style args, no `DEVICEID`/`KEY`.

### `KEYS-CLEAR DEVICEID=…`
Blank everything.

### `BRIGHTNESS DEVICEID=… VALUE=0..100`

### `VARIABLE-VALUE DEVICEID=… VARIABLE=<id> VALUE=<base64>` (1.7)
Only for `output` variables the client declared. Companion debounces these (5 ms, max 20 ms).

### `LOCKED-STATE DEVICEID=… LOCKED=0|1 CHARACTER_COUNT=n ROTATION=0|90|-90|180` (1.8, `ROTATION` 1.10.1)
Between `LOCKED=1` and `LOCKED=0` no drawing messages are sent and client input is ignored.
Only sent when `PINCODE_LOCK` was requested; otherwise Companion draws lock graphics onto the keys
itself.

### `DEVICE-CONFIG DEVICEID=… CONFIG=<base64 json>` (1.10)
Current values of the `CONFIG_FIELDS` the client declared.

### `PING` / `PONG`
The server may also initiate `PING`; the client must reply `PONG <payload>`.

## 7. Advanced layout manifest (1.9)

base64 of:

```jsonc
{
  "stylePresets": {
    "default": {                       // required
      "bitmap":    { "w": 72, "h": 72 },      // optional
      "text":      true,                       // optional
      "textStyle": true,                       // optional
      "colors":    "hex" | "rgb",             // optional
      "leds":      { "segments": 24, "mode": "full-ring" | "simple" }  // optional (1.13)
    },
    "encoder": { /* … any other named presets … */ }
  },
  "controls": {
    "0/0": { "row": 0, "column": 0, "stylePreset": "encoder" }   // key regex: [a-zA-Z0-9-/]+
  }
}
```

`leds.mode`: `full-ring` — segment 0 at 6 o'clock, increasing clockwise, gauge rendered faithfully;
`simple` — value swept across all segments, segment 0 = 0% end.

Legacy `ADD-DEVICE` params are internally converted into exactly this shape (one control per key id
`"row/column"`, one `default` preset), which is why the mock only needs one internal surface model.

## 8. Config fields (1.10)

base64 of an array of discriminated-union field definitions sharing
`{id, label, description?, tooltip?, isVisibleExpression?}`:

- `{type: 'static-text', value}`
- `{type: 'textinput', default?, regex?, multiline?}`
- `{type: 'dropdown', choices: [{id, label}], default?, allowCustom?}`
- `{type: 'number', min, max, default?, step?}`
- `{type: 'checkbox', default?}`

Values come back to the client via `DEVICE-CONFIG` as a JSON object keyed by field `id`.

## 9. Version history

| Version | Added |
|---|---|
| 1.0.0 | Initial |
| 1.1.0 | `KEY-STATE` `TYPE` and `PRESSED` |
| 1.2.0 | `DEVICEID` on `ERROR` responses |
| 1.3.0 | `KEY-ROTATE` |
| 1.4.0 | `TEXT_STYLE` flag, `FONT_SIZE` |
| 1.5.0 | `BITMAPS` as a size |
| 1.5.1 | Surface size limit removed |
| 1.6.0 | row/column key notation; `TEXTCOLOR`; colour format choice; >32 buttons |
| 1.7.0 | Transferable values (`VARIABLES`, `SET-VARIABLE-VALUE`, `VARIABLE-VALUE`); `BRIGHTNESS` opt-out |
| 1.7.1 | `VARIABLE` echoed in `SET-VARIABLE-VALUE OK` |
| 1.8.0 | `PINCODE_LOCK`, `PINCODE-KEY`, `LOCKED-STATE` |
| 1.9.0 | `LAYOUT_MANIFEST` (advanced surfaces) |
| 1.10.0 | Subscriptions; `LOCATION` on `KEY-STATE`; `FIRMWARE-UPDATE-INFO`; `CONFIG_FIELDS`/`DEVICE-CONFIG`; `CHANGE-PAGE` |
| 1.10.1 | `ROTATION` on `LOCKED-STATE` |
| 1.11.0 | `NONSQUARE` in `CAPS` |
| 1.12.0 | `BITMAP_FORMATS` in `CAPS`, `BITMAP_FORMAT` on `ADD-DEVICE`/`ADD-SUB` |
| 1.13.0 | `leds` style preset, `LEDS` arg |
| 1.14.0 | Signed multi-step `DIRECTION`; `ROTARY_AMOUNT` in `CAPS` |

## 10. Quirk checklist for the mock

These are the things a naive reimplementation gets wrong, and each one is a test case:

1. Trailing space before `\n` on every emitted line.
2. Only the *first* `\r` is stripped from a line.
3. `=` splits on the first occurrence only.
4. Quotes are stripped anywhere in a fragment, not just at the ends.
5. `\` escapes any following character.
6. Bare fragments become `true`.
7. Booleans always emitted as `1`/`0`.
8. `PING` payload is the raw unparsed remainder of the line.
9. `Device exists elsewhere` goes to the *existing* socket, not the requesting one.
10. `Line too long` is emitted as `ERROR ERROR MESSAGE="Line too long"`.
11. `BITMAPS=1` (or any non-numeric truthy, or numeric `<5`) means 72 px.
12. `FONT_SIZE` may be the string `auto`.
13. `LEDS` ignores the negotiated bitmap format.
14. `DIRECTION=0` means −1, not 0.
15. Commands are matched case-insensitively (`cmd.toUpperCase()`), parameter *keys* are not.
