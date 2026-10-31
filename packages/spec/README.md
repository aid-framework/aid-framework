# `@aid-framework/spec`

The spec language of [AID Framework](https://github.com/aid-framework/aid-framework): the JSON Schema, a
position-aware YAML parser, and the structural validator. This is the package that decides whether a document
is a **well-formed** AID spec.

An AID application starts as one declarative YAML file. That file is the source of truth: models, prompts,
tools, retrieval, agents, pipelines and evals are declared once, and everything downstream — the IR, the code
generators, the runtimes — is derived from it.

```yaml
specVersion: "0.1"
project:
  name: support-copilot

models:
  fast:
    provider: openai-compatible
    model: gpt-4o-2024-08-06
    capabilities: [tool-calling, json-schema]

prompts:
  answer:
    template: |
      Answer the customer's question.
      Question: {{ question }}

pipelines:
  answer:
    steps:
      - generate:
          model: fast
          prompt: answer
          input:
            question: "{{ request.question }}"
```

## Install

```sh
npm install @aid-framework/spec
```

Requires Node.js 24 or newer. Shipped as ESM with TypeScript declarations.

## What it does

- **Parses** YAML into a typed document that remembers where every node came from, so a diagnostic can point at
  `file:line:column` instead of only naming a key.
- **Validates** the document against the spec v0.1 JSON Schema, which is also exported for editor autocomplete
  and CI validation.
- **Tells the truth about versions.** A construct the language defines but this build cannot serve is reported as
  `spec/not-supported` naming the version that can — never as a generic schema failure that reads like a typo.

## Quick start

```ts
import { checkSpecText, formatDiagnostics } from '@aid-framework/spec';

const { ok, diagnostics } = checkSpecText(source, { file: 'app/app.spec.yaml' });

if (!ok) {
  process.stderr.write(formatDiagnostics(diagnostics));
  process.exit(1);
}
```

`checkSpecText` parses and validates in one step. It short-circuits on purpose: when the YAML itself cannot be
parsed, semantic validation is skipped, because a semantic message about a half-parsed document is noise.

Working one layer down:

```ts
import { parseSpecDocument, validateSpec, formatDiagnostics } from '@aid-framework/spec';

const parsed = parseSpecDocument(source, { file: 'app/app.spec.yaml' });
const diagnostics = [
  ...parsed.diagnostics,
  ...validateSpec(parsed.value, { file: 'app/app.spec.yaml' }),
];
```

## The document

| Section | Since | Declares |
| --- | --- | --- |
| `specVersion` | 0.1 | The language version of the document |
| `project` | 0.1 | Name and metadata of the app |
| `types` | 0.1 | Named record types shared by prompts, tools and pipelines |
| `models` | 0.1 | Model aliases: provider, pinned model id, capabilities, limits, cost |
| `prompts` | 0.1 | Versioned prompt templates and their typed variables |
| `tools` | 0.1 | Tool contracts, handlers, side effects and auth policy |
| `stores` | 0.1 | Vector store declarations |
| `retrievers` | 0.1 | Retrieval sources, chunking, embeddings and ranking |
| `evals` | 0.1 | Datasets, metrics and gates |
| `pipelines` | 0.1 | The executable graph of steps |
| `agents` | 0.2 | Agent loops, tool sets, transfer/delegation and budgets |
| `guardrails` | 0.2 | Input/output policies and their enforcement |
| `memory` | 0.2 | Conversation, user and global memory scopes |
| `deployments` | 0.2 | Trigger, concurrency and streaming declarations |

The build reads spec versions `0.1`, `0.2` and `0.3`. A section listed as `0.2` is rejected in a 0.1 document,
with a diagnostic naming the version that accepts it.

## Pipeline step kinds

A pipeline step contains exactly one step kind. The validator implements eleven:

`generate`, `retrieve`, `tool`, `emit`, `branch`, `parallel`, `map`, `reduce`, `rerank`, `guard`, `agent`.

`branch`, `parallel`, `map` and `reduce` are the composite kinds — the only ones that may nest another step — and
nesting is bounded. `emit` may not appear inside a composite step, because it terminates the pipeline.

No step kind is deferred in this build. `human` was **retired** rather than deferred: a human-in-the-loop pause is
a property of an agent (`agents[].humanInTheLoop`), so the old spelling produces a diagnostic naming the
replacement instead of "unknown key".

## Diagnostics

Diagnostics are the public contract, not an implementation detail. Every code in `DIAGNOSTIC_CODES` is asserted by
the test suite and printed by `aid validate`, so it is safe to match on in CI. Renaming one is a breaking change.

```ts
import {
  countBySeverity, formatDiagnostics, hasErrors, sortDiagnostics,
} from '@aid-framework/spec';

const { ok, diagnostics } = checkSpecText(source, { file: 'app/app.spec.yaml' });
const failing = hasErrors(diagnostics); // only error severity fails a check; warnings do not
const counts = countBySeverity(diagnostics);
```

Codes are namespaced `spec/*`. Two are worth calling out because they are easy to conflate:

- `spec/not-supported` — the language defines this construct, but this build does not serve it yet. The message
  names the version that does.
- `spec/unknown-key` — nothing defines this key. Almost always a typo.

Keeping them distinct is deliberate: a message saying "not supported" about a misspelled key sends the reader
looking for a missing feature that does not exist.

## JSON Schema

The schema is a package export, so editors and external tools use the same one the validator uses:

```json
{
  "yaml.schemas": {
    "./node_modules/@aid-framework/spec/dist/schema/spec.schema.json": "app.spec.yaml"
  }
}
```

```ts
import schema from '@aid-framework/spec/spec.schema.json' with { type: 'json' };
```

## What this package does not do

It validates one document in isolation. It performs **no** cross-section analysis: no referential integrity, no
capability negotiation, no cost sanity, no security checks. Those need to see the whole program, so they live in
the build-time gates of [`@aid-framework/ir`](https://www.npmjs.com/package/@aid-framework/ir).

Layering is one-directional: `spec ← ir ← generator-sdk ← generators ← cli`. Nothing here imports a package above
it.

## API

| Export | Purpose |
| --- | --- |
| `checkSpecText(text, options?)` | Parse and validate in one step; returns `{ ok, value, diagnostics }` |
| `parseSpecDocument(text, options?)` | YAML → typed document plus positioned diagnostics |
| `validateSpec(value, options?)` | Structural validation of an already-parsed document |
| `specJsonSchema` | The spec v0.1 JSON Schema as an object |
| `SPEC_VERSION`, `SPEC_VERSION_LATEST` | The version `aid init` writes, and the newest version read |
| `SUPPORTED_SPEC_VERSIONS`, `SUPPORTED_SECTIONS` | The version and section vocabularies |
| `SUPPORTED_STEP_KINDS`, `COMPOSITE_STEP_KINDS`, `RETIRED_STEP_KINDS` | The step-kind vocabularies |
| `SECTION_MIN_VERSION` | Which version first accepts each later section |
| `DIAGNOSTIC_CODES`, `SEVERITIES` | The diagnostic vocabulary |
| `formatDiagnostic`, `formatDiagnostics`, `sortDiagnostics` | Rendering |
| `countBySeverity`, `hasErrors` | Inspection |
| `SourceDocument` | A parsed document that carries node positions |

## License

[Apache-2.0](https://github.com/aid-framework/aid-framework/blob/main/LICENSE). Code generated by AID Framework is
not subject to this license.
