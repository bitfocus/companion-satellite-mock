# Satellite protocol conformance corpus

`satellite-corpus.json` is a language-agnostic set of cases for the Satellite API line format.

It is **hand-authored from Companion's documented and observed behaviour** — deliberately not
generated from this implementation's output, which would only assert that we agree with ourselves.
When a case here disagrees with the code, the code is wrong until proven otherwise.

Any satellite client, in any language, can load this file and check its own parser and serialiser
against it. That is the point: prose about the trailing space cannot be executed, and this can.

## Format

```jsonc
{
  "parse": [{ "name": "…", "quirk": 3, "line": "A=1", "expected": { "A": "1" } }],
  "serialise": [
    {
      "name": "…",
      "quirk": 1,
      "message": "KEY-STATE",
      "status": null,
      "deviceId": "dev1",
      "args": { "KEY": 0 },
      "expected": "KEY-STATE DEVICEID=\"dev1\" KEY=0 \n",
    },
  ],
}
```

- `expected` in a parse case maps parameter names to a string, or `true` for a bare flag. Keys the
  parser must _drop_ simply do not appear.
- `args` values are typed: a JSON number serialises bare, a boolean as `1`/`0`, a string quoted.
- `quirk` refers to the numbered list in [`docs/protocol.md`](../../../docs/protocol.md#1-wire-quirks).
