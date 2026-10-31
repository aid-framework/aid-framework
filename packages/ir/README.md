# `@aid-framework/ir`

The intermediate representation of [AID Framework](https://github.com/aid-framework/aid-framework): the one
normalized, stack-independent, versioned form of an application that every code generator consumes.

Generators never read a spec. This package resolves the spec **once** into an IR, so a Python target and a
TypeScript target are looking at the same program — the same names, the same defaults, the same resolved
references.

```text
spec.yaml ──buildIR──▶ IR ──runGates──▶ buildable ──▶ generator plan ──▶ code
```

## Install

```sh
npm install @aid-framework/ir
```

Requires Node.js 24 or newer. Depends only on `@aid-framework/spec`.

## Quick start

```ts
import { checkSpecText, formatDiagnostics } from '@aid-framework/spec';
import { buildIR, runGates, serializeIR } from '@aid-framework/ir';

const checked = checkSpecText(source, { file: 'app/app.spec.yaml' });
if (!checked.ok) throw new Error(formatDiagnostics(checked.diagnostics));

const built = buildIR(checked.value, { file: 'app/app.spec.yaml' });
if (built.diagnostics.some((d) => d.severity === 'error')) {
  throw new Error(formatDiagnostics(built.diagnostics));
}

const gates = runGates(built.ir, { file: 'app/app.spec.yaml' });
if (!gates.ok) throw new Error(formatDiagnostics(gates.diagnostics));

const canonical = serializeIR(built.ir);
```

`buildIR` resolves every type, model, prompt and tool reference eagerly, materializes every default, and derives
each stable identity from identity rather than from content — so editing one prompt does not renumber an unrelated
pipeline.

## The IR

`IR_VERSION` is `"0.1.0"`. `specVersion` is carried through from the spec, so a consumer can always tell which
spec revision produced an IR. The two are independent: neither implies the other.

An IR always carries all nineteen top-level keys, even when a collection is empty:

```text
irVersion, specVersion, project, types, models, prompts, tools, retrievers, embeddings,
stores, memory, agents, pipelines, evals, guardrails, deployments, observability, runtime,
requiredCapabilities
```

### An empty collection is a contract

An empty array here is not "missing" — it is a statement. The collections are present and required by the schema
even when empty, so a later version can fill one in without touching a single consumer:

- `agents`, `guardrails`, `memory`, `deployments` — declared by the spec language but unused by this document.
- `embeddings` — not a spec section at all. A spec declares embedding capacity by giving a model the `embeddings`
  capability and pointing a retriever at it, so this collection is **derived** from that content. Empty means the
  app embeds nothing.

`observability` and `runtime` are objects with defaults rather than arrays: tracing on, and a runtime descriptor
naming plain-async control flow.

## The build-time gates

Gates decide whether an IR is buildable, before a single byte of code is emitted. There are sixteen, run as one
report by `runGates`. All of them emit diagnostics rather than throwing, in the same compiler-style shape as
`@aid-framework/spec`, so a user gets one report whatever layer rejected the input.

| Gate | Rejects |
| --- | --- |
| `referential` | An unresolvable type or reference, a reference of the wrong kind, prompt variables that do not match the template, an undefined or duplicated step binding, a malformed eval target, a fallback cycle |
| `normalize` | A value left implicit for the generator to invent, a provider this build does not serve, params above a model's limits |
| `capability` | A target declaring no capabilities, an unknown target, a capability outside the vocabulary, a required capability the target does not declare |
| `cost` | A budget declared against an unpriced model. Warns for an estimate above a budget, and for an unpriced, unbudgeted model |
| `security` | A write or destructive tool with no auth policy, a destructive tool without confirmation, an under-redacting trace config, an HTTP path reaching a write with no auth |
| `eval-coverage` | Nothing — warns when an HTTP-served pipeline has no CI-gating eval |
| `agents/refs-resolve` | An agent naming a tool, prompt or model that does not exist |
| `agents/handoff-cycles` | Transfer or delegation graphs that can re-enter an agent |
| `agents/budgets` | An agent budget that cannot be honoured |
| `agents/budget-degrade` | `onBudgetExhausted: degrade` with no strictly cheaper alias to step down to |
| `guardrails/coverage` | A guardrail not attached to an input or output it can act on |
| `guardrails/policies` | A guardrail policy that does not parse, or names an unknown builtin |
| `hitl/side-effects` | A human-in-the-loop pause guarding a side effect it cannot actually hold |
| `memory/refs` | A memory reference that does not resolve to a declared scope |
| `deploy/streaming` | A deployment declaring streaming the target cannot emit |
| `orchestration/deepagents` | An agent engine declaration the runtime cannot honour |

**Suppression is explicit.** A check this build genuinely cannot enforce appears in `suppressed` with a stated
reason rather than being skipped silently — because a skipped check and a passing check look identical from the
outside.

The capability set the gates check is derived from the IR's own content and written back onto
`requiredCapabilities`, so the value a generator reads is the value that was actually checked:

```ts
const result = runGates(ir, {
  targetCapabilities: {
    'py-fastapi': ['http-trigger', 'json-schema', 'otel'],
  },
});

result.ok;         // false when any gate emitted an error
result.byGate;     // per-gate diagnostics
result.suppressed; // what was not enforced, and why
```

## PolicyExpr

Tool auth policies are written in a small expression language. This package parses them into a plain-JSON AST, so
the AST can live in the IR, serialize canonically, and be evaluated by any target in any language.

```text
or         := and ('or' and)*
and        := comparison ('and' comparison)*
comparison := unary (('==' | '!=' | '<' | '<=' | '>' | '>=') unary)?
unary      := 'not' unary | primary
primary    := 'true' | 'false' | builtin '(' args ')' | '(' or ')'
builtin    := hasRole | hasScope | isAuthenticated
```

```ts
import { parsePolicyExpr, formatPolicyExpr } from '@aid-framework/ir';

const parsed = parsePolicyExpr("hasRole('admin') or hasScope('tickets:write')");
if (parsed.ok) console.log(formatPolicyExpr(parsed.value));
```

Parsing is a total function: it returns either an AST or positioned diagnostics, never a thrown exception.
Anything outside this grammar is a validation error, including an unknown builtin. That is the fail-closed rule —
a policy the runtime cannot evaluate must never be treated as `true`.

Eval predicates use a companion grammar with the same properties (`parsePredicateExpr`, `PREDICATE_BUILTINS`), so
a gate condition is as strict as an auth policy.

## Canonical serialization

`serializeIR` is deterministic, so regeneration is byte-reproducible and golden files are stable:

- object keys sorted, LF endings, two-space indent, exactly one trailing newline;
- no `NaN`, `Infinity` or `undefined`; an absent field is omitted rather than written as `null`;
- array order preserved, because an array's order is meaningful and an object's is not.

Two documents that differ only in key order or whitespace therefore produce byte-identical IR.

## Model catalog

The catalog is the build-time source of truth for model pricing and limits, used by the `cost` and `normalize`
gates.

```ts
import {
  CATALOG_VERSION, catalogCostProfile, catalogCostProfiles, catalogModel,
} from '@aid-framework/ir';
```

The catalog JSON is also exported as `@aid-framework/ir/catalog/models.json`, and the IR schema as
`@aid-framework/ir/ir.schema.json`.

## Capabilities

```ts
import {
  DEFERRED_CAPABILITIES, MODEL_CAPABILITIES, REQUIRED_CAPABILITIES,
  deriveRequiredCapabilities, isRequiredCapability,
} from '@aid-framework/ir';
```

`deriveRequiredCapabilities(ir)` returns the capabilities the IR's own content requires, in vocabulary order.
`runGates` calls it before gating, so the gates and the generator never disagree about what is required.

## API

| Export | Purpose |
| --- | --- |
| `buildIR(value, options?)` | Spec value → `{ ir, diagnostics }` |
| `runGates(ir, options?)` | Run all gates; returns `{ ok, diagnostics, suppressed, byGate }` |
| `GATES` | The gate registry, in execution order |
| `serializeIR(ir)`, `canonicalJson(value)` | Canonical JSON rendering |
| `IR_VERSION` | The IR shape version (`0.1.0`) |
| `IR_COLLECTIONS`, `IR_ONLY_COLLECTIONS` | The collection vocabulary |
| `deriveRequiredCapabilities(ir)` | The capabilities the content requires |
| `REQUIRED_CAPABILITIES`, `MODEL_CAPABILITIES`, `DEFERRED_CAPABILITIES` | The capability vocabularies |
| `parsePolicyExpr`, `formatPolicyExpr`, `POLICY_BUILTINS` | The tool-auth policy language |
| `parsePredicateExpr`, `formatPredicateExpr`, `PREDICATE_BUILTINS` | The eval predicate language |
| `catalogModel`, `catalogCostProfile`, `catalogCostProfiles`, `CATALOG_VERSION` | Model pricing and limits |

## License

[Apache-2.0](https://github.com/aid-framework/aid-framework/blob/main/LICENSE). Code generated by AID Framework is
not subject to this license.
