# What we take from Companion, and how to refresh it

Three different relationships with upstream, deliberately kept distinct — because they have very
different refresh costs and failure modes.

## 1. Copied verbatim — `packages/protocol/src/upstream/`

| File                                | Upstream path                                                       |
| ----------------------------------- | ------------------------------------------------------------------- |
| `SatelliteSurfaceManifestSchema.ts` | `companion/lib/Service/Satellite/SatelliteSurfaceManifestSchema.ts` |
| `SatelliteConfigFieldsSchema.ts`    | `companion/lib/Service/Satellite/SatelliteConfigFieldsSchema.ts`    |

Pinned at commit
[`3d76cba`](https://github.com/bitfocus/companion/commit/3d76cbadedab21d5dc7e14d3b332557248513b1a)
(2026-08-21). MIT, © Bitfocus AS.

These lift cleanly because they import nothing but `zod`. They are also the _source of truth_: the
published `assets/satellite-surface.schema.json` and `assets/satellite-config-fields.schema.json` are
generated from them, so copying the zod gives runtime validation and identical error messages, where
generating types from the JSON assets would give only types. For a server that must validate what
clients send, the zod is strictly the better artifact.

> companion-satellite takes the other route — `tools/schema_compile.mts` runs
> `json-schema-to-typescript` over `../../companion/assets/*.schema.json`, i.e. it assumes Companion
> is checked out as a sibling directory. That works for a client that only needs types, but it
> couples the build to a local checkout, which is not something we want.

**These files are excluded from Prettier and ESLint** so they stay byte-identical and a refresh is a
clean diff. Do not edit them; if something needs changing, change it upstream.

**To refresh:** re-copy the file, keep the provenance header, update the commit hash above and in the
header, then run `yarn test`. `schemas.test.ts` is a tripwire, not a test of zod — if upstream
changes what a client may send, it fails and the change gets noticed.

## 2. Ported, and proven equivalent — `packages/protocol/src/parse.ts`, `serialise.ts`

`parseLineParameters`, `isTruthy`, `isFalsey` and `parseStringParamWithBooleanFallback` live in
`companion/lib/Resources/Util.ts`, a grab-bag module with a dozen unrelated Companion imports. There
is no clean file to lift, so these are hand-ported.

Equivalence is _proven_, not asserted: `parse.upstream.test.ts` holds a verbatim copy of upstream's
function as a fixture and runs both over 20 000 seeded random lines.

**One caveat learned the hard way.** A differential test is only as faithful as the fixture's
_dependencies_. The first version of this port used a three-entry `BANNED_PROPS` and the differential
test passed — because the fixture had been handed our constant instead of upstream's, so both sides
were wrong identically. The real set has seven entries and lives in the published
`@companion-app/expressions` package. Copied constants now get their own pin (`bannedProps.test.ts`),
independent of any test that might share them.

`@companion-app/expressions` is on npm, so `BANNED_PROPS` _could_ be imported — but it drags in
acorn, jsonpath-plus, type-fest and unicode-segmenter for a seven-element `Set`, which is a poor
trade for a package whose whole point is to stay dependency-light.

## 3. Referenced only

`SatelliteApi.ts`, `SatelliteRenderUtil.ts` and `Surface/IP/Satellite.ts` are the behavioural
reference, read and re-implemented. They are entangled with `SurfaceController`, `ServiceApi`,
`ImageResult` and Companion's graphics stack, so there is nothing to lift. `docs/protocol.md` records
what was read out of them.

One candidate for a future lift: `shared-lib/lib/Graphics/GaugeLeds.ts` (`sampleLedsToBuffer`), which
maps a gauge onto LED segments. Every satellite client that supports LED rings needs the inverse of
it, and it is not published anywhere.

---

## If upstream wanted to publish a package

> Written up in full in [shared-package-proposal.md](./shared-package-proposal.md), including what
> adoption would cost each consumer and how this repo would migrate. Summary below.

Worth noting the duplication is already real, and predates this repo: **Companion and
companion-satellite each carry their own copy of `parseLineParameters`** — `companion/lib/Resources/Util.ts`
and `satellite/src/client/parser.ts` — and they have already drifted (upstream's `BANNED_PROPS` comes
from `@companion-app/expressions`; satellite's is a local seven-entry literal). This repo would be a
third copy. Three copies of a parser whose _quirks are load-bearing_ is the argument.

A `@companion-app/satellite-protocol` package, dependency-light (`zod` only), would cover:

| Contents                                                                                                    | Who uses it today                                                                             |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `parseLineParameters`, `isTruthy`/`isFalsey`, `BANNED_PROPS`                                                | Companion, companion-satellite, this mock                                                     |
| Line serialisation (the trailing-space quirk and all)                                                       | Companion, this mock — clients need it to _parse_, so a shared codec keeps both halves honest |
| The two zod schemas, with the JSON schema assets as build output                                            | Companion (validation), companion-satellite (types), this mock (validation)                   |
| Constants: `MAX_KEYS_TOTAL`, `MAX_KEYS_PER_ROW`, `MAX_LINE_LENGTH`, reserved prefixes, id/location patterns | Companion, this mock                                                                          |
| The error-string table                                                                                      | Companion, this mock — and it would let client test suites assert against real strings        |
| API version → capability table                                                                              | companion-satellite (it already does version gating with `semver`), this mock                 |
| `sampleLedsToBuffer` + its inverse                                                                          | Companion, any LED-capable client                                                             |

The version→capability table is the one that would repay the effort most: right now every client
re-derives "what does API 1.9 support" from prose, and gets to find out at runtime when it guesses
wrong.

Caveat on scope: an npm package does nothing for a native client directly. What _does_ cross language
boundaries is the published JSON schemas and a machine-readable version→capability table — worth
publishing as data assets alongside the package, not just as TypeScript.
