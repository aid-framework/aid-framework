---
description: "The CLI's ten commands, its exit taxonomy, and its refusal to own rules that already live in the IR or the generators."
---

# Runtime to CLI

The CLI is the smallest layer and the one with the strictest contract, because CI reads it. It is
ten commands, one exit taxonomy, and a deliberate refusal to own any rule that already lives
somewhere else.

## The commands

| Command | Does |
| --- | --- |
| `aid init` | Scaffolds `app/app.spec.yaml` and a root `README.md`, refusing to overwrite either. |
| `aid validate` | Parses, validates and runs every IR gate. Reports; writes nothing. |
| `aid gen` | Compiles and reconciles the tree. `dev` runs the same generator before serving. |
| `aid dev` | Regenerates, then runs the application's own server on loopback, for the targets that have one. |
| `aid guard` | Measures the app's declared guardrail table against a red-team corpus and gates on recall and false positives. |
| `aid migrate` | Emits the SQL the declared vector stores need, for an operator to apply once. |
| `aid ingest` | Runs the generated ingest module for one retriever or all of them. |
| `aid eval` | Runs one generated eval module, or records its baseline. |
| `aid cost` | Reports cost, token and latency totals from the runtime's local trace sink, optionally failing when they exceed `--budget`. Reads; never reprices. |
| `aid trace` | Prints a run's span tree from the same sink, with model, tokens, cost and time per span. Reads; replays nothing. |
| `aid doctor` | Diagnoses the tree against the spec: hand-edited generated files, provenance and version mismatches, and missing or outdated generated files. Reports; writes nothing. |
| `aid eject` | Takes ownership of a generated file: moves it to `business/` and excludes it from generation. |
| `aid infra` | Emits, plans and applies deployment infrastructure for the spec's declared environments, through `tofu` or `cdk`. `plan`/`apply` spawn the binary in the environment root, so `tofu -chdir=infra/envs/<env> init` comes first. |

## The exit taxonomy

`exit.ts` calls this "a contract with CI rather than a convention", and it is exact:

| Code | Meaning |
| --- | --- |
| `0` | The command finished **and** the project is in the shape the command asked for. |
| `1` | The command ran, but the spec, a gate, the target's compiler or the working tree said no. |
| `2` | The invocation was wrong, or the CLI could not get far enough to judge the project at all. |

Nothing else is ever returned, and **no command maps two different outcomes onto the same code**.
That is what makes `aid gen` usable as a CI gate: `1` always means "fix your project", never
"you typed the command wrong".

## The compile pipeline

`pipeline.ts` runs one sequence for every command that needs a project:

```text
read the spec -> lower to IR -> run every gate -> ask the target to compile -> plan -> reconcile
```

Three properties are choices rather than accidents, and each one is visible in behaviour:

- **Stages stop at the first error.** Lowering a spec whose schema already failed would report a
  cascade of consequences of the first mistake, which buries it. Warnings produced before the stop
  are kept, because the design emits some deliberately - `ir/eval-uncovered` warns rather than
  fails, and it still appears on a run that later stops.
- **The target's compiler runs before its planner.** `checkPlan` reports every problem at once;
  `plan` throws. Asking first is what lets `aid gen` print the target's own codes and paths instead
  of a stack trace with an exception dressed up as a diagnostic.
- **The CLI introduces no gate, no hash, no drift rule and no manifest reader of its own.** Every
  step is a call into `@aid-framework/spec`, `@aid-framework/ir`, `@aid-framework/generator-sdk` or
  the target generator. The docstring states the reason plainly: a second implementation of a gate
  is a defect, because the two can disagree and only one of them will be right.

## The target registry

`targets.ts` is the one place the CLI learns what a target *is*, and it restates as little as
possible:

- the **layout** - spec path, generated root, business root, manifest path, eval module names -
  comes from `generator-sdk`'s `managedRoots` and the generator's own path helpers, so a generator
  that moves a file moves every command with it;
- the **capabilities** come from `generator-sdk`, not from `@aid-framework/ir`'s
  `phase0TargetCapabilities` placeholder. Feeding the placeholder to the capability gate would make
  it pass vacuously for every spec - the one failure mode a gate must not have.

## `gen`: four decisions

`aid gen` decides which target, which spec, whether to write, and what the exit code means. That is
the whole list. Everything about *what* changes belongs to the SDK: `planRegeneration` decides the
actions, `regenerate` applies them, and the drift rule that refuses to overwrite an edited generated
file is the SDK's.

One divergence is documented as a choice: **the manifest is written even when the run reports
drift**, so a run that refuses an edit and a run that discards one cannot disagree about what is on
the tree.

## `dev` serves the application, not a second application

`aid dev` regenerates the tree and then starts the server the application already declares:

```bash
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Generation is part of the command because the promise is "the spec you just edited is what is
serving requests". A `dev` that served a tree compiled from an older spec would answer from code
the developer is no longer looking at, so a generation failure stops the command before any server
starts -- it is the same failure `aid gen` would have reported, carried through unchanged.

The server is the target's, not the CLI's. `py-fastapi` emits routers and the **application** owns
`app/main.py`, which decides what to mount and how to run it; a dev server implemented in the CLI
would be a second, drifting way to run the same app. `ts-vercel` is a deployment target - Next
mounts its route handlers and it ships no server of its own - so `Target.dev` declares
`{ kind: 'none', reason }` for it and the command **refuses** with that reason as exit **2** rather
than inventing one.

Two smaller decisions are pinned by tests. `-m uvicorn` rather than the `uvicorn` binary, because
the probe that proves an interpreter can import the runtime also proves it can import uvicorn - a
`uvicorn` script on `PATH` proves neither, and the two can be different interpreters. And the host
is `127.0.0.1`: a `0.0.0.0` default would quietly expose a half-built app to the network.

The banner is printed *before* the child starts, unlike every other command's text, because the
dispatcher prints only after the command returns and the server runs for an unbounded time. A
signal-terminated child (Ctrl-C) is reported as a clean stop, since that is how a foreground server
ends. `--json` is refused: a JSON document describes a finished run, and this one produces a
stream. Editing the *spec* is not watched - uvicorn reloads code, and regenerating needs the
generator to run again - so restart `aid dev` after a spec change.

## `eval` and `ingest` are thin wrappers

Both shell out to a generated module, which is the surface the spec already declares:

```bash
python -m app.generated.evals.classify_quality
python -m app.generated.retrieval.ingest.handbook
```

That is also what a person would type by hand, and it is why neither command re-derives chunking,
store configuration or metrics.

A Node target runs the **file**, not a module name: the emitted module compares `process.argv[1]`
against its own URL before running its gate, so the file is the only thing that makes it an entry
point. The emitted code also uses NodeNext `.js` specifiers, which a `.ts` source tree does not
have, so `aid eval` passes `ts-loader.ts` as Node's `--import` hook:

```bash
node --import ./packages/cli/dist/ts-loader.js app/generated/evals/classify_quality.ts
```

That rewrites `../deps.js` to `../deps.ts` in the resolve hook, so no `dist/` has to exist first.
`python.ts` exists so the Python driver has **one** definition of "a usable interpreter" - the
active project interpreter first, `uv` last. The Node driver is `process.execPath`, because the CLI
is already a Node program and a second, discovered Node could be older than the one running the
command.

`--baseline` delegates the sampling to the module: Python's recipe calls `run()` and
`EvalBaseline.from_run`, Node's calls `recordBaseline()`. Both sample the spec's `samples` count
once, so the CLI and the module cannot disagree about how many runs a baseline means.

One thing the command cannot fix for you: a retrieval eval measures the store as it is, and a
`kind: memory` store is per process. `aid eval handbook_quality` in a fresh process therefore sees
an empty index and scores 0.0 - a true measurement of nothing. Index in the same process that
scores, as the generated `app/generated/evals/run-evals.mjs` driver does, or point the retriever at
a store that outlives the process.

The error split follows the taxonomy: `--retriever` and `--all` together, or neither, is **2**
before the spec is even read, and an id the spec does not declare is also **2** with a message
naming the ids that exist. A missing generated module is **1**, because the invocation was right
and the project is not.

## `cost` reads the sink; it does not price

Both runtimes write one JSONL span per line whenever `AID_TRACE_DIR` is set. That is the directory
`aid cost` reads, which is why the command defaults to the same variable rather than inventing a
path of its own:

```bash
AID_TRACE_DIR=.aid/traces python -m app.server
AID_TRACE_DIR=.aid/traces node .next/standalone/server.js

aid cost .aid/traces
aid cost .aid/traces --since 2026-10-01 --json
aid cost .aid/traces --budget 0.50       # exit 1 when the measured spend exceeds $0.50
```

`--budget` compares the total against a ceiling and nothing more: it is the same recorded
`aid.cost.usd` sum the report prints, not a second price model. Generating a project with eval
gates opts the nightly run into this: the workflow captures spans into `.aid-traces` and passes
`--budget "$BUDGET"` only when a repository variable `AID_COST_BUDGET` is set, so an unconfigured
project reports spend instead of failing on a ceiling nobody chose.

Each span carries `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, the model the provider
served, and `aid.cost.usd` - the price the runtime gateway computed for that call. `aid cost` sums
those fields and reports nearest-rank p50/p95 latency over model-call spans. It contains **no
pricing table**: the build-time estimate is the IR's cost gate, and a second rule in the CLI would
be a second answer to the same question.

A span with tokens but no `aid.cost.usd` is counted under `unpricedSpans` and kept out of the total.
It is not summed as zero, because a missing price would otherwise read as a cheap run.

The taxonomy holds here too. A missing directory, or one that is not a directory, an unparseable
`--since`, and a `--budget` that is not a plain non-negative decimal are **2**; a trace file that
exists but cannot be read, or a measured total above `--budget`, is **1**, with the readable rest
still reported; an empty directory is **0** with a warning, because zero spans is a true statement
rather than a failure.

## `trace` shows the shape of a run; it does not replay it

`aid trace` reads the same spans as `aid cost` and shows what a single request actually did - the
span tree, in start order, with each span's parent, model, tokens, cost and elapsed time:

```bash
aid trace .aid/traces                    # list runs, newest first
aid trace .aid/traces --all              # every run's tree
aid trace .aid/traces 4f2a                # one run, by id or unambiguous prefix
aid trace .aid/traces 4f2a --json
```

A run is the set of spans sharing a `trace_id`. The listing gives each run's id, start time, span
count, duration, tokens and cost, so the expensive and the slow requests are visible without
opening a file. Selecting by prefix is allowed because trace ids are long; a prefix matching more
than one run is **2** and names the candidates rather than picking one.

The command is **inspect-only**: it never re-executes a model call, and no flag can. The sink
records spans - names, timings, and the attribute set above - and deliberately records no prompt or
response payload, so there is nothing to replay. Showing the tree is the honest scope of a reader
over that file, and a `--replay` flag would have to be a lie or a second, unbounded feature.

The taxonomy is `cost`'s: a missing or non-directory path, an unknown run selector, an ambiguous
selector, and `--all` combined with a run selector are **2**; an unreadable file is **1** with the
readable rest still shown; an empty sink and a sink holding no spans are **0** with a warning.

## `guard` measures the table the app ships, not the detectors

`aid guard` answers one question: given a corpus of payloads, would **this app** have caught
them? The detectors are not reimplemented here. The command imports the same guardrail table
the routes import - `app/generated/guardrails.py` on `py-fastapi`, `app/generated/guardrails.ts`
on `ts-vercel` - hands the engine every declaration covering a fixture's stage, and asks
which one fired:

```bash
aid guard                              # corpus discovered beside the spec, then at the root
aid guard --red-team corpora/owasp.json
aid guard --json
```

That is deliberately a different measurement from `runtimes/python/tests/redteam/`, which
builds one `GuardrailDefinition` per fixture and runs it alone because it is testing the
detectors themselves. A second implementation in the CLI would drift from the one the
routes run, and the number it produced would describe the CLI rather than the
application.

The corpus is an input rather than something the CLI ships. `--red-team` names a file;
without it the command looks for `redteam.json` beside the spec and then at the project
root. The framework's own corpus lives in the runtime's test suite because that is where
`test_redteam.py` gates on it - shipping a copy inside the CLI would be a second copy to
keep in step.

A corpus is `version: 1`, an optional `threshold` block, and a `fixtures` array. Each
fixture names one `stage` (`input`, `output`, `retrieval`, `tool-call`), one `policy`, the
payload, and `known_bad`. `expect` may restate `known_bad`; a fixture where the two
disagree is refused rather than resolved in one direction.

Two facts are reported separately, and the separation is the point:

- **Undeclared** (`input/secret-scan`) means no guardrail names that policy at that stage.
  It is a spec fix, and the command warns rather than fails - the fixture was never
  eligible to be caught.
- **Missed** means a declaration covers the policy and the detector did not match. It is a
  detector fix, and it fails the run.

Which program imports the table is the target's business. A Python target is measured by an
interpreter that can import `aid_runtime`, because that is what the emitted module is. A
TypeScript target is measured by the Node already running the CLI: `aid` is a Node program,
and Node 24 loads the emitted `.ts` module directly, so there is no build step and no
second toolchain to install. Both drivers do the same four things - import the table, pick
the stage method, turn the verdict into a row, print JSON - so detection is written once.

The taxonomy holds: a missing, malformed, or too-small corpus, and (for a Python target) no
interpreter that can import the runtime are **2**; no guardrails declared, a tree with no
emitted guardrail table, a failed run, and a recall or false-positive rate that misses the
corpus's threshold are **1**. The command never regenerates: it measures the tree it is
given, so run `aid gen` first.

## `migrate` moves schema creation to the operator

Both runtimes create their own schema on first connect, with `CREATE ... IF NOT EXISTS`. That
makes a fresh deployment work with no setup, and it is also why a production role needs
`CREATE TABLE`: the first request may arrive before the table does. `aid migrate` is how you
stop needing that. It emits the same DDL as a reviewable file, an operator applies it once
with a role that can create tables, and the application's `IF NOT EXISTS` becomes a no-op
under a role that can only `INSERT` and `SELECT`.

```bash
aid migrate                                  # writes migrations/aid-schema.sql
aid migrate --out db/migrations
aid migrate --check                          # fails when the committed file is stale
aid migrate --dry-run                        # prints, writes nothing
```

Four decisions the command makes, and why:

- **Bootstrap only.** Every statement is idempotent, so re-applying is harmless. The file
  creates and never alters: once `aid_chunks` exists, `IF NOT EXISTS` skips the table, so an
  edited vector dimension would report success while the column kept its old type. A changed
  dimension is a *new* migration, and the header says so where the person editing the file
  will read it.
- **No `--target`.** The SQL is identical for both runtimes - same table, same columns, same
  operators - so a per-target flag would imply a difference that does not exist.
- **One file, whatever the store count.** The runtimes share a single `aid_chunks` table and
  do not key rows by store id, so a second `pgvector` store is not a second table. One file
  per store would print the same DDL twice and invite the reader to believe the stores are
  isolated.
- **The file is identified by its own header.** `migrations/` is a directory people keep
  their own migrations in, so the command only rewrites or deletes a file carrying the
  header it writes. A hand-written `aid-schema.sql` is refused with
  `cli/refusing-to-overwrite` and left byte-identical.

Two details are worth knowing before you read the output. The embedding column is pinned
when the spec pins a dimension, taken from the store or, failing that, from the embedder that
writes to it; when neither says, the column stays bare, as both runtimes declare it. And the
index - HNSW with `vector_cosine_ops`, `vector_ip_ops` or `vector_l2_ops` per the retriever's
metric - is emitted by this command rather than by the runtimes, which create no index at all;
without it a `pgvector` retrieval is a sequential scan.

The table DDL is a **third copy** of a statement that already lives in
`runtimes/python/.../pgvector.py` and `runtimes/typescript/.../pgvector.ts`, because neither
publishes it as an importable value. `migrate.test.ts` reads both sources and fails when
either stops agreeing with the CLI's copy, so the duplication is guarded rather than hoped
for.

The taxonomy holds: `--out` that escapes the repository, and a target with no driver, are
**2**; `--check` against a stale file, and an existing file this command does not own, are
**1**; a spec with no `pgvector` store is **0** and removes a file this command previously
wrote, because the declared state is now "no schema".

## The pattern to copy

This is the codebase's organising principle, and every layer page on this site is an instance of
it: **the spec layer decides shape, the IR layer decides coherence, the SDK decides ownership and
determinism, the generator decides bytes, the runtime decides execution, and the CLI decides only
the exit code.** When you find the same rule written twice, treat the second copy as a bug.

Read next: [Concepts](concepts.md) for the layer diagram, or
[Contributing](../contributing.md) if you intend to change one of these layers.
