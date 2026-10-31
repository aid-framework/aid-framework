# `@aid-framework/generator-sdk`

The plugin contract for [AID Framework](https://github.com/aid-framework/aid-framework) generators. It defines
what a generator **is**, and supplies the three things every generator needs in order to be safe to re-run: a
manifest, an ownership and drift algorithm, and a determinism contract.

If you are writing a target — a new language, a new hosting platform — this is the package you implement. If you
are only *using* AID, you do not call it directly: `aid gen` does.

```text
spec ← ir ← generator-sdk ← generator-<target> ← cli
```

## Install

```sh
npm install @aid-framework/generator-sdk
```

Requires Node.js 24 or newer.

## The three jobs

1. **Say what you are.** A manifest declares the target id, the IR range you accept, the capabilities you can
   honour, and the runtime you emit against.
2. **Never destroy a human's edit.** Files are split into a generator-owned tier and a developer-owned tier, and
   regeneration refuses to overwrite a generated file whose bytes have changed.
3. **Emit the same bytes twice.** Given the same IR, a generator must produce byte-identical output — no
   timestamps, no host names, no absolute paths, no randomness.

## The manifest

```ts
import type { GeneratorManifestInput } from '@aid-framework/generator-sdk';

const input: GeneratorManifestInput = {
  name: 'my-target',
  target: 'my-target',
  version: '0.1.0',
  irRange: '^0.1.0',
  capabilities: ['http-trigger', 'json-schema', 'otel'],
  emitsAgainst: {
    structuredOutput: 'zod',
    tracing: 'otel-genai',
  },
  output: {
    root: 'app',
    generatedDir: 'generated',
    businessDir: 'business',
  },
};

const parsed = parseManifest(input);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics, null, 2));

checkIRSupport(parsed.manifest, IR_VERSION);  // [] when irRange covers this IR
validateGeneratorSet([parsed.manifest]);      // [] when the set is coherent
```

`emitsAgainst` is what makes two targets comparable. A target emitting Pydantic models and OTel spans is not
interchangeable with one emitting Zod and a different tracer, and the declaration says so in **data** rather than
in prose.

| Key | Vocabulary |
| --- | --- |
| `runtime` | The runtime the output is paired with, e.g. `py-fastapi` |
| `orchestration` | `ORCHESTRATIONS` |
| `tracingBackend` | `TRACING_BACKENDS`, e.g. `otel-genai` |
| `structuredOutput` | `STRUCTURED_OUTPUTS`, e.g. `zod`, `pydantic` |

Validation returns diagnostics, never thrown exceptions, in the same compiler-style shape as
`@aid-framework/spec` and `@aid-framework/ir`. Codes are namespaced `generator/*`. `validateGeneratorSet`
additionally rejects two generators claiming the same `target`.

A manifest is data, which is why capabilities travel into the IR gates as an argument:

```ts
import { targetCapabilityDeclarations } from '@aid-framework/generator-sdk';
import { runGates } from '@aid-framework/ir';

runGates(ir, { targetCapabilities: targetCapabilityDeclarations(manifests) });
```

## `generated/` and `business/`

The two-tier split is the reason regeneration is safe.

| Tier | Owner | On regeneration |
| --- | --- | --- |
| `generated/` | the generator | overwritten — never hand-edit |
| `business/` | you | created once if missing, then **never touched** |

`business/` is the seam: it is what generated code calls into. That is where your prompts, tool handlers and
domain logic live, and it is why regenerating does not cost you your work.

Ownership is decided by **where a path lives**, not by what a generator claims. Every planned path is normalized,
so a generator cannot escape its own root, cannot claim a `business/` path as generated, and cannot write the
manifest file itself.

```ts
import {
  isBusinessPath, isGeneratedPath, isReservedPath, ownerForPath, validatePlan,
} from '@aid-framework/generator-sdk';
```

## The drift algorithm

This is the whole safety story, in five steps:

1. **Plan.** `plan(ir)` is pure. It writes nothing.
2. **Check generated files.** If a planned `generated/` file exists and its hash is not the one recorded in the
   manifest, a human edited it. Do not overwrite. Write the new content beside it as `<path>.aid-rej` and fail
   with guidance.
3. **Create business files.** Only if missing. Never overwrite.
4. **Write atomically**, then update the manifest.
5. **Report** created / updated / unchanged / kept / conflicts.

Step 2 is the point. A generator that overwrites unconditionally destroys the one signal it has that a human
disagreed with it, and the loss is silent. Refusing, keeping the rejected bytes, and naming the escape —
`--force` to discard the edit — turns silent data loss into a decision you make explicitly.

```ts
import { hasDrift, planRegeneration, regenerate } from '@aid-framework/generator-sdk';

// Pure: computes what would happen and writes nothing.
const preview = planRegeneration(plan, { sink, manifest });
if (hasDrift(preview)) {
  // preview.actions carries { kind: 'drift', path, recordedSha256, actualSha256 }
}

const { report, manifest: next } = regenerate(plan, { sink, manifest, provenance });
```

`RegenerationAction` is `create | update | unchanged | keep-business | drift`, so `--dry-run` renders from the
same code path that writes.

Two limits are deliberate:

- A file under `generated/` that exists but has **no** record in the manifest is treated as drift rather than
  adopted, because it cannot be proven unmodified.
- Stale generated files — recorded but no longer planned — are reported but never deleted unless pruning is
  requested explicitly. Deletion is the one operation with no recovery.

## Determinism

The contract is narrow and absolute: **no timestamps, no host names, no absolute paths, no randomness** in
generated code. One timestamp turns every regeneration into a diff, and golden-file tests compare bytes.

```ts
import { checkDeterminism } from '@aid-framework/generator-sdk';

const violations = checkDeterminism(files); // { path, pattern, line, excerpt }[]
```

| Export | Purpose |
| --- | --- |
| `normalizeNewlines`, `ensureTrailingNewline`, `normalizeText` | Line-ending and trailing-newline normalization |
| `sha256Hex`, `stableId` | Content hashes and stable identities |
| `compareIds`, `sortById`, `sortByPath`, `stableSortBy` | Order by a stable id, not by walk order |
| `generatedBanner` | The do-not-edit header and its marker |
| `DETERMINISM_PATTERNS`, `scanForNonDeterminism` | The rule set and a per-file checker |
| `checkDeterminism` | Run the whole rule set over a file set |

`scanForNonDeterminism` is what lets a generator's own tests fail the build when it emits a timestamp. That is
what makes the contract testable instead of aspirational.

The contract applies to **generated code, never to model output**. Completions are expected to vary; eval gating
accounts for that by sampling rather than by comparing bytes.

## The manifest on disk

`aid.manifest.json` records provenance — generator name and version, IR version, spec version — plus one entry
per file: `path`, `owner`, `sha256`, `generator`, `generatorVersion`. That record is what makes step 2 above
possible.

```ts
import { manifestFor, parseAidManifestJson, serializeAidManifest } from '@aid-framework/generator-sdk';

const written = manifestFor(files, provenance);
const text = serializeAidManifest(written); // canonical: sorted keys, LF, one trailing newline
```

## The generator interface

```ts
import type { Generator } from '@aid-framework/generator-sdk';

export const myGenerator: Generator = {
  name: manifest.name,
  target: manifest.target,
  version: manifest.version,
  irRange: manifest.irRange,
  plan: (ir) => planMyTarget(ir),
  emit: (plan) => plan.files,
};
```

Every identity field is read off the manifest, so a manifest a loader validated and the generator it then ran
cannot disagree about which target, version or IR range they describe.

## API

| Export | Purpose |
| --- | --- |
| `parseManifest`, `parseManifestJson`, `validateManifest`, `validateGeneratorSet` | Manifest handling |
| `checkIRSupport`, `supportsIR` | IR range compatibility |
| `managedRoots`, `targetCapabilityDeclarations` | Manifest → IR gates |
| `validatePlan`, `isRecord` | Plan validation |
| `planRegeneration`, `regenerate`, `checkDrift`, `hasDrift` | The drift algorithm |
| `staleGeneratedFiles`, `generatedFiles` | Inventory of a previous run |
| `createNodeSink`, `createMemorySink` | On-disk and in-memory regeneration sinks |
| `ownerForPath`, `isGeneratedPath`, `isBusinessPath`, `isReservedPath`, `escapesRoot` | Ownership predicates |
| `rejectionPath` | Where rejected bytes are parked |
| `manifestFor`, `parseAidManifest`, `serializeAidManifest` | The on-disk manifest |
| `checkDeterminism`, `DETERMINISM_PATTERNS`, `scanForNonDeterminism` | Determinism |
| `parseRange`, `satisfies`, `compareVersions` | The shared semver vocabulary |

## License

[Apache-2.0](https://github.com/aid-framework/aid-framework/blob/main/LICENSE). Code generated by AID Framework is
not subject to this license.
