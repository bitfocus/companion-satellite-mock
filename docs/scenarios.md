# Scenarios

A scenario decides what a claimed surface shows and how it reacts. Pick one in the web UI; the
surface redraws immediately.

Every scenario **degrades** rather than failing when the client did not negotiate what it wants. A
client under development may not have implemented bitmaps yet, and that is exactly when the mock is
most useful — so a bitmap scenario still shows colour and text on a surface without them. The UI
lists what each scenario wants, and the Device panel shows what your client actually asked for.

| Scenario                 | What it is for                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unclaimed**            | The default, and what an evaluator sees. Draws the claim code onto the buttons so there is nothing to copy out of the app, plus live buttons proving the surface responds before anyone claims it.                                           |
| **Input echo**           | The most useful one during development. Each control shows what the server received _and how it interpreted it_ — the resolved control id, the raw rotation delta and a running total. If your key numbering is off by one, this is where you see it. |
| **Companion home**       | A believable Companion page: `PAGEUP`/`PAGENUM`/`PAGEDOWN` keys, realistic labels, press latching. The one to use for screenshots and a demo video.                                                                                                   |
| **Colour & text matrix** | Text designed to break naive rendering: long strings, multiple lines, accents, RTL, CJK, emoji, and both numeric and `auto` font sizes.                                                                                                               |
| **Bitmap torture**       | Corner-numbered alternating tiles. A transposed, mirrored or wrongly-strided image is obvious at a glance rather than something you have to squint at.                                                                                                |
| **Encoder lab**          | Rotation with a value gauge and `LEDS` output. Shows the raw `DIRECTION`, so a 1.14 multi-step rotation can be told apart from a client sending repeated single steps.                                                                                |
| **Pincode lock**         | Drives `LOCKED-STATE`. The PIN is `1234`. On a client that did not request `PINCODE_LOCK`, it draws lock graphics onto the keys instead, exactly as Companion would.                                                                                  |
| **Brightness ramp**      | Ramps `BRIGHTNESS` 0–100 and back. A client that opted out with `BRIGHTNESS=0` correctly receives nothing.                                                                                                                                            |
| **Variables**            | Streams `VARIABLE-VALUE` for each output variable your client declared, and displays whatever it sends back via `SET-VARIABLE-VALUE`.                                                                                                                 |
| **Attract loop**         | A slow colour sweep for an unattended demo or a screen recording.                                                                                                                                                                                     |
| **Load sweep**           | The bounded load tool. See below.                                                                                                                                                                                                                     |

## The load tool, and what it does not tell you

It drives the surface at a capped frame rate for a fixed time, then stops itself.

It is deliberately a **payload sweep rather than a flood**. A flood mostly measures the server and
the network, and with the render cache warm the server barely notices — the number it produces is
not about your device at all. What is useful is finding where a _client's_ decode and render
pipeline stops keeping up, which is a function of payload size and rate.

For that reason it draws unique content on every frame. Repeating content would be served from the
render cache, and you would be measuring the cache.

Caps: 30fps, 60 seconds, 512 controls. It also passes through the per-session render budget and the
connection's byte limits like everything else.

## Writing another one

A scenario is a small module implementing `Scenario` (see `packages/server/src/scenarios/types.ts`).
It gets a context with `draw`, `drawAll`, `clear`, `setBrightness`, `setLocked`, `sendVariable` and
`sendDeviceConfig`, plus `controlIds` in reading order so it can lay content out without knowing
whether the client registered a legacy grid or a manifest.

Scenarios never touch sockets, and anything one throws is contained and logged rather than taking
the connection down. All ticking comes from one shared timer for the whole server, so a scenario
declares `tickMs` rather than owning a timer.
