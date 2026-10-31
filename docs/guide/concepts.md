---
description: "The four layers — spec, IR, generators and runtime — and why keeping them separate explains most of the framework's behaviour."
---

# Concepts

Four layers, each with one job. Almost everything surprising about this framework is a
consequence of keeping them separate, so this page is the shortest route to the rest of the
documentation.

```text
  app.spec.yaml          you write this
        |
        v
      spec  -----------> parse, resolve, validate against JSON Schema
        |
        v
       IR   -----------> stack-independent, and where every gate runs
        |
        v
      plan  -----------> the exact file set one target will write
        |
        v
  app/generated/**  +  app/business/**     your repository
        |
        v
     runtime  --------> a library the generated code imports
```

## The spec is the source of truth

A spec is one YAML file that declares the parts of an AI service that are structure rather
than prose: types, models, prompts, tools, stores, retrievers, guardrails, agents, pipelines,
evals and deployments. It is data, so it can be validated, diffed, reviewed and generated
from.

The spec is also versioned. `specVersion` gates what you are allowed to use, so a document
written for `0.1` is not silently reinterpreted when `0.3` adds `models[].cache` - you raise
the version, which is a visible change in a diff.

## The IR is where the gates live

The spec is lowered to an IR: the same document with every reference resolved, every alias
expanded, every pipeline step bound to a concrete binding, and the target-specific choices
still absent. Nothing in the IR names FastAPI or Next.js.

This is where the framework earns its keep. Every build-time gate runs here, so both targets
obey one rule set:

| Gate family | Refuses, for example |
| --- | --- |
| References | A prompt that names a model that does not exist, a variable a template does not declare, a binding read before it is written. |
| Security | Caller text reaching a prompt with no `input` guardrail; a `write` tool with no `auth`; a secret in a store. |
| Cost and limits | A model with no price, a fallback chain that cannot be priced, a `maxTokens` above the model's limit. |
| Coverage | An HTTP pipeline that no `gate.ci` eval targets; a guardrail nothing enforces. |
| Policy expressions | A malformed `when:`, an unknown builtin, an identifier the grammar does not define. |

The codes are stable and greppable - `ir/security-input-guardrail`, `ir/eval-uncovered`,
`ir/cost-profile-unknown` - and each carries the location and a hint, which is why the
[getting-started](getting-started.md) page can show a real error rather than an idealised
one.

## The plan and the ownership tiers

A generator turns the IR into a *plan*: a deterministic list of paths and bytes. Applying
that plan is where the ownership model lives, and it is the same algorithm for every target:

- **`app/generated/**` belongs to the generator.** It is rewritten on every run, except when
  its hash no longer matches the manifest. That mismatch means a human edited generated code.
  The generator then refuses to overwrite, writes the new bytes beside the file as
  `<path>.aid-rej`, and fails with guidance. `--force` discards the edits; that is the one
  escape that exists today, because `aid eject` is specified and not implemented.
- **`app/business/**` belongs to you.** It is created once if missing and never touched again,
  not even under `--force`. This is where a tool body, a prompt override or an evaluator goes.
- **Files that are no longer planned** are reported as "no longer generated" but not deleted,
  because deletion is the one operation with no recovery.
- **`app/aid.manifest.json`** records the hash of every managed file. It is what makes drift
  detectable instead of silent, and it is the reason regeneration is safe to run in CI.

The practical consequence: you can read the generated code to learn what the framework does,
edit it if you must, and the framework will tell you rather than quietly reverting you.

## The runtime is a library, not a server

`aid-runtime-python` and `@aid-framework/runtime` are ordinary packages. They provide the
model gateway, the prompt registry, the pipeline executor, the structured-output retry loop,
the guardrail engine, the retrieval adapters, the agent loop, the eval harness and tracing.

There is no control plane, no proxy and no sidecar: a generated route calls `pipeline.run()`
in-process. Delete the framework from `package.json` and the tree still boots, because what it
imports is a library.

## What is deliberately not abstracted

The abstraction stops at the parts where a wrong guess is worse than the work:

- **Prompt text.** A template is a string you write, not something generated from a schema.
- **Tool bodies.** The spec names a symbol and the generator writes the adapter; the function
  inside is yours, and it is where a real system touches a real database.
- **The decision when a guardrail fires.** `block`, `redact` and `escalate` are declared, but
  what the caller should see is a product decision the spec records rather than invents.
- **Composition.** `map` and `reduce` produce lists; combining them into one value is an
  explicit `generate` step, not a hidden default.

## Where each layer is tested

- The spec layer: schema and parse tests, including a fixture per construct.
- The IR: gate tests, one per code, asserting the message and the location.
- The generators: golden-file tests - `examples/*/app/generated/**` **is** the fixture, so a
  generator change that alters output fails unless the example is regenerated in the same
  commit.
- Cross-target: a conformance suite of 73 cases over 40 operations, so the two targets are
  compared rather than assumed equal. See [Conformance](../reference/conformance.md).

Read next: [Spec to IR](spec-to-ir.md) for the lowering rules, [IR to generator](ir-to-generator.md)
for the plan and determinism contract, [Generator to runtime](generator-to-runtime.md) for the
seam, and [Runtime to CLI](runtime-to-cli.md) for how a command drives all of it.
