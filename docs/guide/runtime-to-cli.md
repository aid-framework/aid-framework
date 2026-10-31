---
description: "The CLI's six commands, its exit taxonomy, and its refusal to own rules that already live in the IR or the generators."
---

# Runtime to CLI

The CLI is the smallest layer and the one with the strictest contract, because CI reads it. It is
six commands, one exit taxonomy, and a deliberate refusal to own any rule that already lives
somewhere else.

## The commands

| Command | Does |
| --- | --- |
| `aid init` | Scaffolds `app/app.spec.yaml` and a root `README.md`, refusing to overwrite either. |
| `aid validate` | Parses, validates and runs every IR gate. Reports; writes nothing. |
| `aid gen` | Compiles and reconciles the tree. The only command that writes an app. |
| `aid ingest` | Runs the generated ingest module for one retriever or all of them. |
| `aid eval` | Runs one generated eval module, or records its baseline. |
| `aid doctor` | Diagnoses the tree against the spec: hand-edited generated files, provenance and version mismatches, and missing or outdated generated files. Reports; writes nothing. |

Six more are specified and not implemented - `dev`, `trace`, `cost`, `guard`, `migrate`, `eject` - so
a stack trace naming one of them is not a bug in the CLI you are holding.

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

## `eval` and `ingest` are thin wrappers

Both shell out to a generated module, which is the surface the spec already declares:

```bash
python -m app.generated.evals.classify_quality
python -m app.generated.retrieval.ingest.handbook
```

That is also what a person would type by hand, and it is why neither command re-derives chunking,
store configuration or metrics. `python.ts` exists so both commands share **one** definition of "a
usable interpreter" - the active project interpreter first, `uv` last. If each command carried its
own discovery, an environment could work for one and not the other with nothing explaining why.

The error split follows the taxonomy: `--retriever` and `--all` together, or neither, is **2**
before the spec is even read, and an id the spec does not declare is also **2** with a message
naming the ids that exist. A missing generated module is **1**, because the invocation was right
and the project is not.

## The pattern to copy

This is the codebase's organising principle, and every layer page on this site is an instance of
it: **the spec layer decides shape, the IR layer decides coherence, the SDK decides ownership and
determinism, the generator decides bytes, the runtime decides execution, and the CLI decides only
the exit code.** When you find the same rule written twice, treat the second copy as a bug.

Read next: [Concepts](concepts.md) for the layer diagram, or
[Contributing](../contributing.md) if you intend to change one of these layers.
