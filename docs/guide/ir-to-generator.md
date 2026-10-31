# IR to generator

A generator is a plugin with two functions: `plan` is a pure function of the IR, and `emit`
turns that plan into bytes. `@aid-framework/generator-sdk` owns the rules in between, and the
split is what makes the safety properties checkable before anything touches disk.

```text
IR
 |  checkPlan(ir)        every problem reported at once, no filesystem
 |  plan(ir)             a list of { path, owner, contents } - pure data
 |  validatePlan(plan)   ownership, path escapes, duplicates - still no filesystem
 v
plan
 |  planRegeneration()   per file: create / update / unchanged / kept / refuse
 |  regenerate()         apply, hashing as it goes
 v
app/generated/**  app/business/**  app/aid.manifest.json
```

## Why a plan

A plan is data: a set of repo-relative paths, each with an owner and its exact bytes. Because it
is data, three properties are decidable **without a filesystem**:

- **Ownership** is decided by *where the path lives*, not by what the generator says about it.
  `ownership.ts` normalises every path, so a generator cannot escape its own root, claim a
  `business/` path as generated, or the reverse.
- **Path escapes** - `../`, absolute paths, Windows drive letters - are refused rather than
  normalised into something surprising.
- **Duplicates** - two entries for one path - are an error, not last-write-wins.

That is the reason `checkPlan` runs *before* `plan` in the CLI. `checkPlan` reports every problem
at once; `plan` throws. Asking first is what lets `aid gen` print the target's own codes and
paths instead of a stack trace.

## The determinism contract

`determinism.ts` states the rule a generator must satisfy: **byte-identical output** means no
timestamps, no host names, no absolute paths and no randomness in generated code. It is not
advice - `scanForNonDeterminism` scans an emitted file set and a generator's own tests run it, so
a violation fails the build instead of turning every regeneration into a diff.

The contract applies to *generated code*, never to model output. A prompt is rendered at run
time; a generated file is not a place for "generated at" comments.

Every generated file also carries a fixed banner, matched by `GENERATED_BANNER_MARKER`, which is
how a reviewer - and the golden-file tests - recognise the tier without opening the manifest.

## One rule, one place

`streaming.ts` in the py-fastapi generator is the clearest example of the discipline, because
three different consumers need the same answer: `validate.ts` refuses a document that asks to
stream without it, `emit/pipelines.ts` emits the `Accept` branch only when it holds, and
`plan.ts` decides whether the SSE module exists at all. Restating the rule in each place would
be three chances to disagree, and the symptom would be a route that advertises SSE and returns
JSON.

The rule itself is a consequence of what a stream can carry. `ModelGateway.stream` yields the
model's own text deltas, so a stream is truthful only when the response **is** one `generate`
step's output:

- exactly **one** step may `generate` - two model calls have one response no single stream can
  produce;
- every step after it may only *project* the response, which today means an `emit` step naming
  an event. A later step that performs an effect would leave that effect unperformed on the
  streaming path while the JSON path still performed it.

Steps **before** the generate step are unrestricted: they run identically on both paths, so
their tool and retrieval guardrails still apply. That is why the shipped example - tool,
retrieve, generate, emit - streams without losing its retrieval.

## Regeneration

`planRegeneration()` classifies each planned path against the tree and the manifest, and the
vocabulary in `aid gen`'s summary is exactly its output:

| Action | Meaning |
| --- | --- |
| `created` | The path did not exist. |
| `updated` | The path existed and its bytes match the manifest, so it is safe to rewrite. |
| `unchanged` | The bytes already equal the plan. |
| `kept` | A `business/` file that exists. Never touched, not even by `--force`. |
| refused to overwrite | A `generated/` file whose hash no longer matches the manifest. New bytes go to `<path>.aid-rej`. |
| `no longer generated` | In the manifest, absent from the plan. Reported, not deleted. |
| `pruned` | Deleted, only when explicitly requested. |

Two details that look like trivia and are not:

- **A newer file is not adopted.** If a `generated/` file on disk postdates the manifest but its
  hash was never recorded, it is treated as drift. "The generator probably wrote this" is not
  evidence that it did.
- **The manifest is written even when the run reports drift.** A refused file keeps its
  *previous* hash, so a refusing run and a discarding run cannot disagree about what is on the
  tree. Skipping the write would leave files this run created unrecorded, and the next run would
  call them drift.

## What the CLI does not do

`aid gen` decides four things and nothing else: which target, which spec, whether to write, and
what the exit code means. It does not re-derive ownership, re-hash a file or re-implement drift,
because a second implementation of that rule would eventually disagree with the first - and the
one that disagreed would be the one holding a developer's edits.

That is the general shape of this codebase: the SDK owns the rule, the generator owns the bytes,
the CLI owns the exit code. When you find two copies of a rule, one of them is a defect.

Read next: [Generator to runtime](generator-to-runtime.md) - what the emitted bytes import.
