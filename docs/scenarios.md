# Scenarios

A scenario decides what a claimed surface shows and how it reacts. Pick one in the web UI; the
surface redraws immediately.

Every scenario **degrades** rather than failing when the client did not negotiate what it wants. A
client under development may not have implemented bitmaps yet, and that is exactly when the mock is
most useful — so a bitmap scenario still shows colour and text on a surface without them. The UI
lists what each scenario wants, and the Device panel shows what your client actually asked for.

| Scenario                 | What it is for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unclaimed**            | The default, and what an evaluator sees. Draws the claim code onto the buttons so there is nothing to copy out of the app. Every key lights up when pressed, proving the surface responds before anyone claims it.                                                                                                                                                                                                                                                                                                                                                                    |
| **Input echo**           | The most useful one during development. Each control shows what the server received _and how it interpreted it_ — the resolved control id, the raw rotation delta and a running total. If your key numbering is off by one, this is where you see it.                                                                                                                                                                                                                                                                                                                                 |
| **Colour & text matrix** | Text designed to break naive rendering: long strings, multiple lines, accents, RTL, CJK, emoji, and both numeric and `auto` font sizes.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Bitmap torture**       | A test pattern on every key, labelled with its row,column. Corner markers show a mirrored, rotated or wrongly-strided image. One-pixel red/blue and red/green stripes and checkerboards show chroma subsampling: under YUV 4:2:2 the brightness-matched red/green stripes vanish into flat brown, while the black-and-white stripes beside them survive, so softened colour can be told apart from blur. Also red text on black and on blue, colour edges on odd and even columns, ramps for banding, and near-black/near-white steps that a video-range (16–235) conversion crushes. |
| **Encoder lab**          | Rotation with a value gauge and `LEDS` output. Shows the raw `DIRECTION`, so a 1.14 multi-step rotation can be told apart from a client sending repeated single steps.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Pincode lock**         | Drives `LOCKED-STATE`. The PIN is `1234`. On a client that did not request `PINCODE_LOCK`, it draws lock graphics onto the keys instead, exactly as Companion would.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Brightness ramp**      | Ramps `BRIGHTNESS` 0–100 and back. A client that opted out with `BRIGHTNESS=0` correctly receives nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Variables**            | Streams `VARIABLE-VALUE` for each output variable your client declared, and displays whatever it sends back via `SET-VARIABLE-VALUE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Attract loop**         | A slow colour sweep for an unattended demo or a screen recording.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## A client has to be able to show the code

The Unclaimed screen draws the claim code onto the surface, so a client must have asked for
**bitmaps or text** in `ADD-DEVICE` to see it. A client that requested only `COLORS` receives the
colours but no code, and cannot be claimed from the web UI at all.

That is not much of a restriction in practice — a colours-only surface cannot display anything
either way — but it is worth knowing while a client is still under development and has not
implemented text or bitmap rendering yet. Add `TEXT=1` early; it is the cheapest of the three.

The layout adapts to what is available: one character per key on a surface with room to spare, and
the whole code on a single key when there is not. Every key lights up while pressed, so the surface
visibly responds before it is claimed.

## No load tool

There used to be a load sweep that drove the whole surface with unique content at a chosen frame
rate. It was removed because it could not measure what it was for. The per-device render budget
throttles it well below what a decent client can decode, so it found the server's ceiling rather
than the client's, and the protocol has no acknowledgement for the server to tell what the client
actually drew. The Attract loop covers "make the surface animate".

## Two things that are panels rather than scenarios

**Device config** and **subscriptions** were listed in the original catalogue as scenarios, but
neither fits: a scenario owns a surface and draws to it on a tick, and both of these are driven
entirely by the operator, on state that is not a surface at all.

- **Device config** renders whatever `CONFIG_FIELDS` your client declared, using Companion's own
  field schema — so what you see here is what Companion's surface settings would show. Editing a
  value pushes `DEVICE-CONFIG` back. Values are coerced against the declared field and anything
  that does not fit is rejected, so a `number` field can never deliver you a string. Note that the
  server also pushes `DEVICE-CONFIG` once immediately after registration, as Companion does; if
  your client only handles it in response to a change, that first one will catch you out.
- **Subscriptions** lists whatever the client registered with `ADD-SUB` and what each one wants
  (bitmap, colours, text). Subscriptions watch an absolute `page/row/column` rather than a surface,
  which is why no scenario can drive them: editing the location's content in this panel pushes
  `SUB-STATE` to every subscription watching it, across every connection.

Both panels are always present. When the client declared no config fields or holds no
subscriptions, the panel says so rather than disappearing, so you can tell "not supported" apart
from "not rendered".

## Writing another one

A scenario is a small module implementing `Scenario` (see `packages/server/src/scenarios/types.ts`).
It gets a context with `draw`, `drawAll`, `clear`, `setBrightness`, `setLocked`, `sendVariable` and
`sendDeviceConfig`, plus `controlIds` in reading order so it can lay content out without knowing
whether the client registered a legacy grid or a manifest.

Scenarios never touch sockets, and anything one throws is contained and logged rather than taking
the connection down. All ticking comes from one shared timer for the whole server, so a scenario
declares `tickMs` rather than owning a timer.
