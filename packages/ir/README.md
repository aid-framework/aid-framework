# `@aid/ir` — the intermediate representation

The IR is the one stack-independent, normalized, versioned representation of an app that every generator
consumes. Generators never read the spec: `@aid/ir` resolves it once, at build time, into something a
generator can emit code from directly.

Layering is strictly one-directional. `@aid/ir` imports `@aid/spec`; `@aid/spec` never imports `@aid/ir`.

## IR v0.1

`IR_VERSION` is `"0.1.0"` and `specVersion` is carried through from `@aid/spec`, so a consumer can tell which
spec revision produced an IR. The two are independent and neither implies the other.

Every IR carries all 19 top-level keys of [`docs/design.md` §7.2](../../docs/design.md):

```text
irVersion, specVersion, project, types, models, prompts, tools, retrievers, embeddings,
stores, memory, agents, pipelines, evals, guardrails, deployments, observability, runtime,
requiredCapabilities
```

Phase 0 populates `types`, `models`, `prompts`, `tools`, `pipelines`, and `evals`.

### Empty collections are a contract, not an omission

Seven collections are **present and empty by design**. They are `[]` rather than omitted or `undefined`, and
the JSON Schema requires each of them, so a later phase can fill one in without touching a single consumer.
An empty array is otherwise indistinguishable from "not implemented", so the two reasons are worth keeping
apart:

- `retrievers`, `agents`, `guardrails`, `memory`, `deployments` — sections the spec **defers**. Layer 1 lists
  them in `DEFERRED_SECTIONS`, so no spec can populate them yet.
- `embeddings`, `stores` — not spec sections at all. They exist only in the IR, as shape reserved for a
  later phase.

`observability` and `runtime` are objects rather than arrays, present with Phase 0 defaults: tracing on, and
a runtime descriptor naming plain-async control flow.

## Building

```ts
import { checkSpecText, formatDiagnostics } from '@aid/spec';
import { buildIR, runGates, serializeIR } from '@aid/ir';

const checked = checkSpecText(source, { file: 'app.yaml' });
if (!checked.ok) throw new Error(formatDiagnostics(checked.diagnostics));

const { ir, diagnostics } = buildIR(checked.value, { file: 'app.yaml' });
const gates = runGates(ir, { file: 'app.yaml' });

if (!gates.ok) throw new Error(formatDiagnostics(gates.diagnostics));
console.log(serializeIR(ir));
```

- `buildIR(value, { file? })` returns `{ ir, diagnostics }`. It resolves every `TypeRef` and every
  `model`/`prompt`/`tool` reference eagerly, materializes every default, and derives each stable identity
  from identity rather than content, so an unrelated edit never churns a generated diff.
- `runGates(ir, { targetCapabilities?, file? })` returns `{ ok, diagnostics, suppressed, byGate }`. `ok` is
  false when any gate emitted an error-severity diagnostic.
- `serializeIR(ir)` renders canonical JSON.
- `deriveRequiredCapabilities(ir)` returns the capabilities the IR's own content requires, in vocabulary
  order. `runGates` sets `requiredCapabilities` from it before gating, so the value on the IR is the one the
  generator should read.

## The six build-time gates

All six run before code generation. They emit diagnostics, never exceptions, and use the same
compiler-style shape as `@aid/spec`, so a user sees one report whatever layer rejected the input. IR codes
are namespaced `ir/*` and never reuse a `spec/*` code.

| Gate | Rejects |
| --- | --- |
| `referential` | An unresolvable `TypeRef` or reference, a reference whose kind does not match (a `tool` step naming a prompt), prompt variables that do not match the template, an undefined or duplicated step binding, a malformed eval target, a `fallbacks` cycle |
| `normalize` | A value left implicit for the generator to invent, a provider Phase 0 does not serve, params above a model's limits |
| `capability` | A target that declares no capabilities, an unknown target, a capability outside the vocabulary, a required capability the target does not declare |
| `cost` | A budget declared against an unpriced model. Warns when an estimate exceeds a budget, and when a model is unpriced but unbudgeted |
| `security` | A `write`/`destructive` tool with no `auth`, a `destructive` tool without `requiresConfirmation`, an under-redacting trace config, an HTTP path that reaches a write with no `auth` |
| `eval-coverage` | Nothing: warns when an HTTP-served pipeline has no `eval` with `gate.ci: true` |

**Suppression is explicit.** A check Phase 0 genuinely cannot enforce appears in `suppressed` with a stated
reason rather than being skipped silently, because a skipped check is indistinguishable from a passing one.
Phase 0 suppresses the guardrail rule: there is no guardrail runtime to enforce it against.

### Capability declarations are injected

`@aid/ir` must not import `packages/generator-sdk`, which does not exist yet, so a target's capability
declaration arrives as a gate argument:

```ts
runGates(ir, { targetCapabilities: { 'py-fastapi': ['http-trigger', 'json-schema', 'otel'] } });
```

`src/catalog/` exports the Phase 0 reference declaration (`PHASE_0_TARGET_CAPABILITIES`) that the default
uses. Layer 3 supplies the real declarations instead, and nothing else in this package changes.

## Canonical serialization

`serializeIR` is deterministic so that regeneration is byte-reproducible and golden files are stable: object
keys sorted, LF endings, 2-space indent, exactly one trailing newline, no `NaN`/`Infinity`/`undefined`, and
`undefined` fields omitted rather than written as `null`. Array order is preserved because an array's order
is meaningful; an object's is not. Two spec documents that differ only in key order or whitespace produce
byte-identical IR.

## PolicyExpr

`src/policy/` parses the policy mini-language used by `tool.auth` into a plain-JSON AST, so the AST can be
embedded in the IR, serialized canonically, and evaluated by any target.

```text
or         := and ('or' and)*
and        := comparison ('and' comparison)*
comparison := unary (('==' | '!=' | '<' | '<=' | '>' | '>=') unary)?
unary      := 'not' unary | primary
primary    := 'true' | 'false' | builtin '(' args ')' | '(' or ')'
builtin    := hasRole | hasScope | isAuthenticated
```

Parsing is a total function: `parsePolicyExpr(source, context?)` returns either an AST or position-bearing
diagnostics, never a thrown exception. **Anything outside this grammar is a validation error**, including an
unknown builtin. That is the fail-closed rule: a policy the runtime cannot evaluate must never be treated as
`true`.

## Development

```sh
pnpm build
pnpm test
```

Fixtures live in `test/fixtures/`, so this package's tests do not depend on `@aid/spec`'s own fixtures.
`test/__golden__/` holds the committed canonical IR for the full fixture, compared byte for byte.

Reference: [`docs/design.md` §7](../../docs/design.md).
