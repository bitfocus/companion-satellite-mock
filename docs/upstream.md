# What comes from Companion

## Used directly — `@companion-app/satellite-protocol`

Companion publishes its Satellite API codec as
[`@companion-app/satellite-protocol`](https://www.npmjs.com/package/@companion-app/satellite-protocol),
and Companion's own server uses it. The mock depends on it (in `packages/protocol`) for:

- the line codec: `parseLineParameters`, `formatSatelliteMessage`, `splitSatelliteCommand`, the
  truthy/falsey helpers and `BANNED_PROPS`;
- `SatelliteLineBuffer`, which splits incoming data into lines exactly as Companion does;
- the zod schemas for `LAYOUT_MANIFEST` and `CONFIG_FIELDS`;
- the protocol constants: API version, line length, key limits, bitmap formats.

So parsing, line splitting, quoting and escaping are Companion's code, not a copy of it.
`packages/protocol` adds what is specific to the mock: the outbound message builders, the surface
model, the per-version server behaviour (`capabilitiesFor()`), config value handling, and the chaos
tool's framing options on top of the formatter.

The dependency is pinned to `~0.1.x` while the package is pre-1.0. **To update it**, bump the range
and run `yarn test`. Four things will catch a change in behaviour:

- `parse.test.ts` pins each wire quirk in docs/protocol.md §1;
- `corpus.test.ts` runs the package's own conformance corpus through the mock's parser and
  serialiser;
- `versions.test.ts` checks that `capabilitiesFor()` gates every feature on the same API version
  as the package's feature table;
- `schemas.test.ts` fails if the schemas change what a client may send.

## Referenced only

`SatelliteApi.ts`, `SatelliteRenderUtil.ts` and `Surface/IP/Satellite.ts` in Companion are the
behavioural reference, read and re-implemented: they are tied to the rest of Companion, so there is
nothing to import. docs/protocol.md records what was read out of them.

Two things the mock carries that the package does not, and that other clients would benefit from
if they were published there:

- the error-string table (`ERRORS` in `packages/protocol/src/constants.ts`), so client tests can
  assert against Companion's real strings;
- `sampleLedsToBuffer` from Companion's `shared-lib/lib/Graphics/GaugeLeds.ts`, which maps a gauge
  onto LED segments. Every client with LED rings needs its inverse.
