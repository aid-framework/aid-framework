# Getting started

This page scaffolds a project, adds one pipeline, generates it, and serves it. Every CLI
command on this page, and every error message, was run against `@aid-framework/cli` 0.1.48.

You need **Node.js 24 or newer**. Nothing has to be cloned; the CLI is published.

## 1. Scaffold a project

```bash
npx @aid-framework/cli init my-app
cd my-app
```

The command writes two files and stops:

```console
created app/app.spec.yaml
created README.md
next: aid validate, then aid gen
```

`app/app.spec.yaml` is the source of truth. `README.md` is a note to your future self about
which directory the generator owns.

## 2. Look at the starter spec

```yaml
specVersion: "0.1"

project:
  name: my-app
  targets:
    - py-fastapi
```

That is deliberately the smallest legal spec. `init` writes `specVersion: "0.1"` - the
original surface - and you raise it when you use a later construct:

| Version | Adds |
| --- | --- |
| `0.1` | The original surface: types, models, prompts, tools, stores, retrievers, pipelines, evals. |
| `0.2` | The closed `agents`, `guardrails`, `memory` and `deployments` sections. |
| `0.3` | `models[].cache` - prompt and semantic caching. |

A section or construct that needs a later version is reported as `spec/not-supported` with
the version it needs, so you get told rather than silently ignored. Raise the value yourself;
`init` does not guess.

## 3. Validate

```bash
npx @aid-framework/cli validate
```

```console
app/app.spec.yaml: ok (0 errors, 0 warnings)
```

`validate` parses the spec, lowers it to the IR, and runs every build-time gate. It writes
nothing. It exits `0` on success, `1` on a failed gate, and `2` on a usage error - the full
set is in the [CLI reference](../reference/cli.md).

## 4. Add a pipeline

Replace the contents of `app/app.spec.yaml` with this. It declares one model, one prompt, one
input guardrail, one HTTP pipeline and one emitted type.

```yaml
specVersion: "0.2"

project:
  name: my-app
  targets:
    - py-fastapi

types:
  Reply:
    kind: struct
    fields:
      text:
        type: string
        required: true

models:
  fast:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY
    capabilities: [json-schema]
    params:
      temperature: 0.2
      maxTokens: 256
    costProfile: openai-gpt-4o-mini
    limits:
      maxInputTokens: 8192
      maxOutputTokens: 256

prompts:
  greet:
    version: 1
    model: fast
    template: |
      Reply to this customer message in one sentence.

      Message: {{ message }}

      Answer with a JSON object holding exactly one field:
        * text: the reply to send
    variables:
      message:
        type: string
        required: true
    output:
      kind: structured
      schema: Reply

guardrails:
  message_injection:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: The message looked like an attempt to override the assistant.
      log: true

pipelines:
  hello:
    description: Reply to one message.
    trigger:
      http:
        method: post
        path: /hello
    steps:
      - generate:
          prompt: greet
          input:
            message: "{{ event.message }}"
          as: reply
      - emit:
          event: Reply
```

Three parts of that are load-bearing and worth naming before the gates complain about them.

**No `guardrails` block means no validation.** The security gate refuses a `POST` trigger
that passes caller-supplied text to a prompt when the document declares no guardrail with an
`input` stage:

```console
app/app.spec.yaml: error: the security gate rejected this endpoint: the POST /hello trigger
passes caller-supplied text to prompt "greet", but the specification declares no guardrail
with an "input" stage [ir/security-input-guardrail]
    at pipelines.hello.steps[0]
    hint: declare a guardrail with stages: [input]
```

That is not a lint. It is the framework's central claim enforced at build time, and it is
the reason a minimal spec cannot quietly ship an unprotected endpoint.

**A pipeline needs a final `emit`.** `emit` names the type the HTTP response is built from,
and the route is generated from it. Leaving it out is not caught by `validate` - `gen`
reports it as an internal error and exits `2`:

```console
aid: internal error in `gen`: internal: an emit step for pipeline 'hello' is missing after
validation; this is a generator bug
```

Treat that message as "add the `emit` step". It is a sharp edge, and it is recorded here
because a reader will meet it.

**An uncovered HTTP pipeline warns.** Validating a pipeline that no eval targets still
succeeds, with one warning:

```console
warning: the eval-coverage gate flagged this pipeline: "hello" is served over HTTP but no
eval with gate.ci: true targets it [ir/eval-uncovered]
```

Warnings do not fail the command. Turning the warning into an eval is
[step 6 of the support-copilot walkthrough](../walkthroughs/support-copilot.md).

## 5. Generate

```bash
npx @aid-framework/cli gen
```

```console
py-fastapi: 20 created, 0 updated, 0 unchanged, 0 kept
created:
  app/business/__init__.py
  app/generated/__init__.py
  app/generated/contracts/__init__.py
  app/generated/deps.py
  ...
```

(with the full list elided; the command prints all twenty). Running it a second time with no
spec change reports `17 unchanged` and `3 kept`: the three seeded files under `app/business/`
belong to you, so the generator leaves them alone instead of counting them unchanged. The
tree, the ownership rule and the manifest are described in
[The generated tree](generated-tree.md).

## 6. Serve it

The generated routers import `aid-runtime-python`. The ASGI entry point is yours - a few
lines that mount the generated router:

```python
from fastapi import FastAPI

from app.generated.routes.hello import hello_router

app = FastAPI()
app.include_router(hello_router)
```

```bash
python -m venv .venv
.venv/bin/pip install aid-runtime-python "fastapi>=0.115,<1" "uvicorn>=0.30,<1"
.venv/bin/uvicorn app.main:app --reload
```

```bash
curl -sS -X POST localhost:8000/hello \
  -H 'content-type: application/json' \
  -d '{"message": "I was charged twice this month"}'
```

```json
{"text": "I am sorry about the duplicate charge - I can look into it now."}
```

This request needs `OPENAI_API_KEY` in the environment, because `fast` is a real provider.

The `provider: fake` model that the examples use is a **test double**, not a no-key
deployment option: it is a seeded simulation that deliberately answers correctly only a
fraction of the time, so a prompt declaring `output.kind: structured` against it fails with
`StructuredOutputError` after three attempts rather than producing an answer. The examples
run offline because they inject a scripted fake through the generated `setDeps` seam, which
is what [Serving an app](serving.md) covers.

## Where to go next

- [Writing a spec](writing-a-spec.md) - the surface, in the order you will reach for it.
- [The generated tree](generated-tree.md) - what each generated file is for, and what you
  are allowed to edit.
- [Concepts](concepts.md) - spec, IR, generator, runtime: why there are four layers.
- [CLI reference](../reference/cli.md) - every command, flag and exit code.
