# Spec to IR

Two packages, one direction: `@aid-framework/spec` decides whether a document is *well formed*,
`@aid-framework/ir` decides whether it is *coherent*. Every gate lives in the second, so both
targets obey one rule set.

```text
app.spec.yaml
   |  packages/spec/src/parse.ts        YAML -> document value, with source positions
   |  packages/spec/src/validate.ts     JSON Schema, required keys, enums, patterns
   v
validated document
   |  packages/ir/src/build.ts          lower, apply defaults, resolve, sort
   |  packages/ir/src/gates/index.ts    runGates(): 16 gates, one report
   v
IR v0.1  --(packages/ir/src/serialize.ts)--> canonical JSON
```

## Stage one: the document is real

`parse.ts` turns bytes into a value while keeping every node's source position, which is why a
diagnostic can say `app/app.spec.yaml:142:9` rather than naming a key. `validate.ts` applies the
JSON Schema - the same one that generates the [spec reference](../reference/spec.md), so the
documentation and the validator cannot drift apart.

The schema is strict about shape and permissive about meaning. It will refuse `specVersion: "0.4"`
and a `stages` value that is not in the enum. It will not tell you that a prompt names a model
you never declared. That is stage two.

## Stage two: the builder

`build.ts` carries three statements worth quoting, because each is a design decision you can
feel later:

- **It never throws for a user-recoverable condition.** A bad spec produces `ir/*` diagnostics
  through the same shape as every other gate, so the CLI prints them all in one format and
  stops at the first *stage* that failed, not the first exception.
- **It applies Phase 0 defaults here, not in generated code.** So "the generator supplies a
  default of its own" is a bug you can catch by reading the generator, and the resolved value
  is visible in the IR you can serialize and diff.
- **It sorts every object-derived collection by stable id.** YAML key order therefore cannot
  change the IR, which is what makes byte-identical regeneration possible from hand-edited
  YAML.

Along the way it parses the two expression languages into ASTs: `policy/` for the `when` of a
`branch` and the `auth` of a tool, and `predicate/` for the conditions an eval declares. Both
are a hand-written lexer and parser rather than `eval` or a general expression library, so an
unknown identifier or an unclosed parenthesis is a diagnostic with a position
(`ir/policy-unknown-identifier`, `ir/predicate-unclosed-paren`) instead of a runtime surprise.

## The gate registry

`runGates()` runs sixteen gates and returns one report: `ok`, sorted `diagnostics`, a `byGate`
breakdown, and `suppressed`. Suppressed checks are reported *with a reason*, because a
silently-skipped check is indistinguishable from a passing one.

| Gate | Refuses |
| --- | --- |
| `referential` | A reference to something undeclared or of the wrong kind, a forward binding read, a duplicate binding, a prompt placeholder and variable that disagree, or a fallback chain that does not terminate. |
| `normalize` | An IR value the builder left implicit - it re-runs `normalize` and diffs. |
| `capability` | A step that needs a capability the target does not declare. |
| `cost` | An **unpriced** model that a budget was declared for - it fails closed rather than assume the model fits - or a retrieval path whose chunk volume alone exceeds a budget. |
| `security` | A `write`/`destroy` tool with no `auth`; caller text reaching a prompt with no `input` guardrail; a connection string written literally instead of `env:NAME`. |
| `eval-coverage` | *(warns)* an HTTP pipeline no `gate.ci: true` eval targets. |
| `agents/refs-resolve` | An agent naming a prompt, model, retriever, memory tier, guardrail or tool that does not exist. |
| `agents/handoff-cycles` | A handoff graph with a cycle, reported once at the agent that closes it. |
| `agents/budgets` | An agent that can take more than one step and declares nothing that stops it - "no budget" reads as unbounded, never as a default. |
| `agents/budget-degrade` | `onBudgetExhausted: degrade` with no pinned fallback that is strictly cheaper, so the promise has nowhere to go. |
| `guardrails/coverage` | A tool that writes or destroys reaching no guardrail stage that can inspect the call first. |
| `guardrails/policies` | A policy outside the closed vocabulary, a `redact` that names nothing, or a guardrail covering a tool that does not exist. |
| `hitl/side-effects` | A write/destroy tool reachable with neither a HITL policy nor `requiresConfirmation: true`. |
| `memory/refs` | A memory reference that does not resolve, or a tier kind with no model (summary) or store (semantic/episodic/vector). |
| `deploy/streaming` | A deployment requesting `streaming` on a target that does not declare the capability. |
| `orchestration/deepagents` | A delegated agent loop with an unpinned version, or with no tools to drive. |

Three properties matter more than the list. Gates are **independent**: each reads the IR and
reports, so adding one does not require touching the others. `contract.ts` enforces that a gate
never throws for a user-recoverable condition. And the capability set the gates check is
**derived from the IR itself** in `runGates()`, so the value a generator later consumes is the
value that was checked rather than whatever the caller passed in.

## Two rules that are not here

Not every refusal lives in this layer, and knowing where to look saves time:

- **A guardrail that inspects `output` on a streaming deployment** is refused by the *target's
  plan compiler* in `aid gen`, as `unsupported-streaming`. `aid validate` returns ok. See
  [Serving](serving.md#streaming).
- **A pipeline with no final `emit`** is not a validation diagnostic at all; `gen` fails with an
  internal error. See [getting started](getting-started.md#_4-add-a-pipeline).

Both are defects of placement rather than of intent, and both are listed in
[Troubleshooting](../troubleshooting.md).

## The capability trap the CLI avoids

`@aid-framework/ir` exports a `phase0TargetCapabilities` placeholder so the capability gate
could be written before a real generator existed. Feeding that placeholder to the gate would
make the gate pass **vacuously** for every spec. The CLI therefore reads the capability
declarations from `@aid-framework/generator-sdk` instead - the same declarations the generator
is built against. It is a good illustration of the general rule: a gate that cannot fail is
worse than no gate.

## Canonical output

`serialize.ts` is the determinism contract for the IR, and it is narrow on purpose:

- object keys sort; **array order is preserved**, because a pipeline's step order is meaning and
  a map's key order is not;
- output is LF-terminated with exactly one trailing newline;
- `undefined` keys are omitted rather than written as `null`;
- `NaN` and `Infinity` are **refused** rather than serialized as invalid JSON.

Because the IR is canonical, two specs that mean the same thing serialize to the same bytes -
which is what lets the golden-file tests compare IRs, and what makes "regeneration produced no
diff" a meaningful assertion instead of a hopeful one.

Read next: [IR to generator](ir-to-generator.md) - what consumes this IR.
