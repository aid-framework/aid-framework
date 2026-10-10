# `@aid/generator-sdk` — generator plugin interface

Defines what a generator plugin *is*, so third-party and first-party targets are built the same way, and
supplies the three things every generator needs to be safe to re-run: a manifest, an ownership/drift
algorithm, and a determinism contract.

Layering is strictly one-directional: `spec ← ir ← generator-sdk ← generators ← cli`. This package imports
`@aid/ir` and `@aid/spec`; neither may import this one. That constraint is why a target's capability
declaration travels as **data** (`targetCapabilityDeclarations`) rather than the IR's capability gate
reaching in here — [`@aid/ir`'s README](../ir/README.md) documented the placeholder it ships, and this
package is the replacement for it.

## The generator manifest

A generator declares itself with a `GeneratorManifest` (`GENERATOR_MANIFEST_VERSION` is `"0.1.0"`): `name`,
`target`, `version`, `irRange`, `capabilities`, `emitsAgainst`, `output`, and an optional `optionsSchema`.

`emitsAgainst` is the interesting field, because it is what lets a generated app be reasoned about rather
than only diffed. It names the runtime the output is paired with and the shape of what gets emitted:

| Key | Values |
| --- | --- |
| `runtime` | e.g. `py-fastapi` |
| `orchestration` | `ORCHESTRATIONS` — Phase 0 emits `plain-async` only |
| `tracingBackend` | `TRACING_BACKENDS` — e.g. `otel-genai` |
| `structuredOutput` | `STRUCTURED_OUTPUTS` — e.g. `pydantic-ai` |

Validation returns diagnostics, never thrown exceptions, in the same compiler-style shape as `@aid/spec` and
`@aid/ir`, so a user sees one report whatever layer rejected the input. Codes are namespaced `generator/*`
and never reuse a `spec/*` or `ir/*` code.

```ts
import { parseManifestJson, validateGeneratorSet, checkIRSupport } from '@aid/generator-sdk';
import { IR_VERSION } from '@aid/ir';

const parsed = parseManifestJson(source);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics, null, 2));

checkIRSupport(parsed.manifest, IR_VERSION); // [] when the generator's irRange covers the IR
validateGeneratorSet([parsed.manifest]);     // [] when the set is coherent
```

- `parseManifest(value)` / `parseManifestJson(text)` return `{ ok, manifest, diagnostics }`.
- `validateManifest(value)` returns the diagnostics for one manifest; `validateGeneratorSet(manifests)`
  additionally rejects two generators claiming the same `target`.
- `supportsIR(manifest, irVersion?)` and `checkIRSupport(...)` compare against `irRange` using this package's
  own semver parser, so the range vocabulary is shared with nothing outside the repo.
- `managedRoots(manifest)` turns a manifest into the `PlanValidationOptions` its plans must satisfy.
- `targetCapabilityDeclarations(manifests)` renders `{ target: capabilities[] }` for
  `runGates(ir, { targetCapabilities })`.
- `phase0TargetCapabilities` / `phase0Generators` are the committed Phase 0 declarations.

Those declarations are deliberately honest rather than aspirational: `streaming` is declared even though the
runtime is request/response only (so the IR vocabulary is exercised end to end), and no `orchestration` is
declared because Phase 0 control flow is plain async.

## `generated/` vs `business/` — the ownership model

The three-tier split is the whole reason regeneration is safe (§8.3, §8.4):

| Tier | Owner | Regeneration behaviour |
| --- | --- | --- |
| `generated/` | the generator | overwritten on every run — never hand-edit |
| `business/` | the developer | written **once**, never overwritten |
| the seam | — | `business/` is what the generator calls into; it is the escape hatch |

Ownership is decided by **where a path lives**, not by what a generator says about it: every planned path is
normalized through `src/ownership.ts`, so a generator cannot escape its own root (`escapesRoot`,
`isAbsolutePath`), cannot claim a `business/` path as generated (`planOwnerMismatch`), and cannot write the
manifest file (`isReservedPath`). `ownerForPath`, `isGeneratedPath` and `isBusinessPath` are the predicates,
parameterized by `DEFAULT_GENERATED_DIR` / `DEFAULT_BUSINESS_DIR`.

## The drift algorithm

This is the algorithm the ownership model exists to support (§10), stated once in `src/drift.ts`:

1. Plan the new file set — `plan(ir) -> Plan` is pure and writes nothing.
2. For each planned `generated/` file: if it exists and its hash is **not** the one recorded in the
   manifest, a human edited generated code. Do not overwrite it; write the new content to `<path>.aid-rej`
   and fail with guidance.
3. For each planned `business/` file: create only if missing. Never overwrite.
4. Write atomically, then update the manifest.
5. Report created / updated / unchanged / conflicts.

Step 2 is the whole point. A generator that overwrites `generated/` unconditionally destroys the one signal
it has that a human disagreed with it, and the loss is silent. Refusing, keeping the rejected bytes next to
the file (`.aid-rej`, per `REJECTION_SUFFIX`), and naming both escapes — `aid eject <path>` to take
ownership of a file, `--force` to discard the edits — turns silent data loss into a decision.

```ts
import { planRegeneration, regenerate, hasDrift } from '@aid/generator-sdk';

const preview = planRegeneration(plan, { sink, manifest }); // pure: nothing is written
if (hasDrift(preview)) {
  // preview.actions carries { kind: 'drift', path, recordedSha256, actualSha256 }
}

const { report, manifest: next } = regenerate(plan, { sink, manifest, provenance });
```

`RegenerationAction` is `create | update | unchanged | keep-business | drift`, so a caller can render a
`--dry-run` from the same code path that writes. Two limits are deliberate: a planned file that is newer than
the manifest but has **no** record at all is treated as drift rather than adopted (an unrecorded file under
`generated/` cannot be proven unmodified), and stale generated files — recorded but no longer planned — are
reported but never deleted unless `prune` is passed explicitly, because deletion is the one operation with no
recovery.

`createNodeSink(root)` writes to disk; `createMemorySink()` is the same `RegenerationSink` interface in
memory, which is what the drift tests drive every action through.

## The manifest on disk

`.aid-manifest.json` (`DEFAULT_MANIFEST_FILENAME`, version `AID_MANIFEST_VERSION`) records provenance —
generator name and version, IR version, spec version — plus one entry per file: `path`, `owner`, `sha256`,
`generator`, `generatorVersion`. It is what makes step 2 above possible, and what lets a later run tell
`unchanged` from `edited`.

```ts
import { manifestFor, parseAidManifestJson, serializeAidManifest } from '@aid/generator-sdk';

const manifest = manifestFor(files, provenance);
const text = serializeAidManifest(manifest);
```

`serializeAidManifest` is canonical — keys sorted, LF endings, one trailing newline — so the manifest itself
does not churn a diff. `emptyAidManifest`, `manifestRecordFor`, and
`parseAidManifest`/`parseAidManifestJson` round out the module.

## Determinism

The contract is narrow and absolute (§8.2): **no timestamps, no host names, no absolute paths, no
randomness** in generated code. A single timestamp turns every regeneration into a diff, and the golden-file
tests (§12 regime A) compare bytes.

```ts
import { checkDeterminism } from '@aid/generator-sdk';

const violations = checkDeterminism(files); // { path, pattern, line, excerpt }[]
```

- Primitives: `normalizeNewlines`, `ensureTrailingNewline`, `normalizeText`, `sha256Hex`,
  `stableId(namespace, value)`, and `compareIds` / `sortById` / `sortByPath` / `stableSortBy` for ordering by
  a **stable ID** rather than by whatever order the IR happened to be walked in.
- `generatedBanner(options)` writes the do-not-edit header (`GENERATED_BANNER_MARKER`), which is the only
  thing standing between a reader and an edit the next regeneration will refuse.
- `DETERMINISM_PATTERNS` is the rule set and `scanForNonDeterminism(path, content)` the per-file checker, so
  a generator's own tests can run the emitted set through it and fail the build. That is what makes the
  contract testable instead of aspirational.

The contract applies to **generated code, never to model output** (§8.2): completions are expected to vary,
and eval gating accounts for that by sampling rather than by comparing bytes.

## Development

```sh
pnpm build
pnpm test
```

`test/` covers the manifest and plan validation, the ownership predicates, the determinism primitives, the
semver range parser, the on-disk manifest, both sinks, and — the suite that matters most — `drift.test.ts`,
which drives every `RegenerationAction` including the refuse-and-write-rejection path.

**Not responsible for:** emitting any specific target's code (see [`../generators/`](../generators/)) or for
the behavior of generated apps (see [`../../runtimes/`](../../runtimes/)).

**Status:** the three responsibilities above are implemented for Phase 0. Deferred by design: escalation
routing and any orchestration beyond plain async (§14) — which is why the Phase 0 capability declarations
declare none.

Reference: [`docs/design.md` §8, §8.3, §8.4, §10](../../docs/design.md).
