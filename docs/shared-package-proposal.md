# Proposal: `@companion-app/satellite-protocol`

**Status: proposal, for revisiting once this repo works.** Nothing here blocks the mock — it ships
today with copied schemas and a proven port ([upstream.md](./upstream.md)). This describes what a
shared package would contain, and what adopting it would cost each consumer.

## 1. Why

The duplication is not hypothetical and it has already drifted:

| Artifact                        | Companion                            | companion-satellite              | this repo           |
| ------------------------------- | ------------------------------------ | -------------------------------- | ------------------- |
| `parseLineParameters`           | `companion/lib/Resources/Util.ts`    | `satellite/src/client/parser.ts` | ported              |
| `BANNED_PROPS`                  | via `@companion-app/expressions`     | local 7-entry literal            | inlined literal     |
| Line serialisation              | `SatelliteSocketWrapper.sendMessage` | — (parses only)                  | ported              |
| Manifest / config-field schemas | zod, authoritative                   | codegen from JSON assets         | zod, copied         |
| Version → capability logic      | implicit in `SatelliteApi.ts`        | hand-rolled `semver` checks      | `capabilitiesFor()` |
| Bounds, patterns, error strings | literals in `SatelliteApi.ts`        | —                                | `constants.ts`      |

Three copies of a parser whose **quirks are load-bearing**, and two independent derivations of "what
does API 1.9 support". The parser copies at least fail loudly when they diverge; the capability logic
fails at runtime, in the field, on someone's surface.

Concretely, three drift bugs that already exist or nearly did:

- `BANNED_PROPS` differs between Companion's source and satellite's copy (7 entries in both, but by
  coincidence of maintenance, not by construction). This repo's port shipped with 3 until a pin test
  caught it.
- Satellite's schema codegen reads `../../companion/assets/*.schema.json` — a _sibling checkout_, so
  the two repos must be cloned together to build.
- The trailing-space quirk exists only in Companion's serialiser. Nothing tests that clients tolerate
  it; nothing could, without a shared codec.

## 2. Scope

Dependency-light: **`zod` only**. No node built-ins, no I/O, isomorphic (browser, node, bundler,
React Native). That constraint is what makes it adoptable everywhere, and it is worth defending.

```
@companion-app/satellite-protocol
├─ codec        parseLineParameters, splitCommand, normaliseLine,
│               serialiseMessage/serialiseError, isSafeValue,
│               isTruthy, isFalsey, parseStringParamWithBooleanFallback,
│               BANNED_PROPS
├─ constants    API_VERSION, MAX_LINE_LENGTH, MAX_KEYS_TOTAL, MAX_KEYS_PER_ROW,
│               LEGACY_* defaults, RESERVED_ID_PREFIXES, ID_PATTERN,
│               LOCATION_PATTERN, BITMAP_FORMATS, ERRORS
├─ schemas      SatelliteSurfaceLayoutSchema, SatelliteConfigFieldsSchema
│               (+ inferred types; the JSON schema assets become build output)
├─ versions     KNOWN_API_VERSIONS, capabilitiesFor(), compareVersions,
│               parseBitmapFormat, parseRotationDelta
├─ leds         sampleLedsToBuffer (from shared-lib/lib/Graphics/GaugeLeds.ts)
│               + the client-side inverse: unpack a LEDS payload to per-segment RGB
└─ assets/      satellite-surface.schema.json
                satellite-config-fields.schema.json
                api-capabilities.json   ← see §5
```

Deliberately **out** of scope: anything touching sockets, rendering, image encoding, or Companion's
surface/control model. Those are where the consumers genuinely differ.

## 3. What each consumer gains, and what adoption costs

### Companion

- **Gains:** one definition of the wire format; the error-string table becomes a typed constant
  instead of inline literals; the version→capability table becomes explicit rather than implicit in
  `SatelliteApi.ts`'s conditionals.
- **Cost:** `Resources/Util.ts` re-exports the codec functions from the package, so the ~30 call sites
  elsewhere in Companion don't move. The zod schema files move into the package and the existing
  `assets/*.schema.json` generation follows them. `SatelliteApi.ts` swaps its literals for imports.
- **Risk:** low, and mechanically checkable — Companion's existing satellite tests plus the
  differential corpus (§4) cover it.

### companion-satellite

- **Gains:** deletes `src/client/parser.ts`; deletes the `tools/schema_compile.mts` codegen and the
  `src/generated/*Schema.ts` output; **stops requiring Companion as a sibling checkout to build**;
  replaces its hand-rolled `semver` feature gating with `capabilitiesFor()`.
- **Cost:** its parser returns `Record<string, string | boolean>` where the package returns
  `string | true | undefined`; that is a small typing change at the call sites in `client.ts`.
- **Risk:** low. This is the consumer that gains most per line changed, and it is the natural first
  adopter after this repo.

### companion-satellite-mock (this repo)

- **Gains:** deletes `packages/protocol/src/parse.ts`, `serialise.ts`, `versions.ts`,
  `constants.ts` and `src/upstream/` — roughly the whole package becomes a re-export plus the
  mock-specific message builders.
- **Cost:** see §6.
- **Risk:** none worth worrying about; this repo is the cheapest place to prove the package works.

### A native (non-JS) client

- **Gains nothing from the npm package directly.** What crosses the language boundary is
  `assets/*.schema.json` and the machine-readable capability table (§5). Worth publishing those as
  data, not only as TypeScript — that is the difference between a native client re-deriving the rules
  from prose and generating them.

## 4. The compatibility corpus — the part that makes this worth doing

Ship a **golden corpus** in the package: a JSON file of `{ line, expectedParams }` cases covering
every quirk, plus `{ message, args, expectedLine }` for the serialiser.

- TypeScript consumers get it as a test fixture.
- **Non-TypeScript clients can run it too.** A Swift, Rust or Python satellite implementation can
  load the same JSON and assert its parser agrees. That is a thing no amount of prose documentation
  achieves, and it is the strongest argument for the package existing at all.
- The differential harness from this repo (`parse.upstream.test.ts`) moves in alongside it, so the
  package itself is checked against Companion's tree rather than the other way round.

## 5. `api-capabilities.json`

The version→capability table as data, not code:

```jsonc
{
  "versions": [
    {
      "version": "1.10.0",
      "companion": "v4.3+",
      "adds": [
        "caps",
        "subscriptions",
        "keyStateLocation",
        "serialParam",
        "configFields",
        "changePage",
        "firmwareUpdateInfo",
      ],
    },
  ],
  "capabilities": {
    "keyStateLocation": {
      "since": "1.10.0",
      "capsFlag": null,
      "description": "KEY-STATE carries LOCATION=page/row/column when known",
    },
    "rotaryAmount": {
      "since": "1.14.0",
      "capsFlag": "ROTARY_AMOUNT",
      "description": "DIRECTION carries a signed step count",
    },
  },
}
```

Note the `capsFlag` distinction, which the published spec is careful about and which is easy to get
wrong: `ApiVersion` says whether a feature _exists_; `CAPS` says whether it is _enabled right now_.
Encoding that as data means every client gates on it the same way.

This file is also what the mock's version-selector UI renders, and what a docs page could be
generated from — so it stops being three descriptions of one table.

## 6. Adopting it here

Deliberately sequenced so this repo is the pilot: it has the least to lose and the best test
coverage of the wire format.

1. **Publish `0.1.0`** built from `packages/protocol` as it stands — it is already almost exactly the
   proposed shape, which is not an accident.
2. **Add the dependency** and reduce `packages/protocol` to:
   - re-exports of the package (so `@satellite-mock/protocol` stays the import site for the rest of
     the repo and step 3 is invisible to `server`/`testclient`),
   - the mock-specific message builders,
   - anything the package deliberately excludes.
3. **Delete** `parse.ts`, `serialise.ts`, `versions.ts`, `constants.ts`, `src/upstream/`,
   `parse.upstream.test.ts`, `bannedProps.test.ts` — all of which exist only because there is no
   package. Keep `schemas.test.ts` and the quirk tests initially, running against the package: if
   they pass unchanged, the package is a faithful replacement, and _then_ they can be dropped as
   duplicates of the package's own suite.
4. **Keep the lint invariant** (`packages/protocol` may not import anything doing I/O) — it should
   apply to the package too, and is worth restating in its repo.
5. **Update** `docs/upstream.md` to describe one dependency rather than three relationships, and
   delete the refresh procedure, which is the entire point.

Because step 2 keeps `@satellite-mock/protocol` as the import site, the blast radius of the whole
migration is one package, whatever else has been built by then. That property is worth preserving
deliberately rather than discovering later.

## 7. Open questions

- **Package name and home.** `@companion-app/satellite-protocol` in the Companion repo as a workspace
  (like `@companion-app/expressions`), or its own repo? A workspace makes Companion's adoption
  trivial and everyone else's a normal npm install.
- **Versioning.** The package version should be independent of the API version it implements — a
  bug fix in the parser is not an API change. `API_VERSION` stays an exported constant.
- **Does Companion want the constraint?** The zero-dependency-beyond-zod rule is what makes it usable
  from a browser bundle and React Native. If Companion later wants to add something needing node
  built-ins, that belongs in a second package rather than relaxing the rule.
- **`sampleLedsToBuffer` direction.** Companion needs gauge→segments; clients need the inverse. Both
  belong here, but the gauge model itself lives in Companion's graphics stack — so the extraction may
  need a small value-object boundary first.
