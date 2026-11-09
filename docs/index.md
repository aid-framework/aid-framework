---
layout: home

hero:
  name: AID Framework
  text: One YAML spec. A production AI service.
  tagline: Models, prompts, tools, guardrails, evals, retrieval, a Dockerfile and OpenTofu infrastructure compiled from one declarative spec into FastAPI or Next.js code you own — with build-time gates that refuse a spec which cannot work.
  actions:
    - theme: brand
      text: Start in 60 seconds
      link: /guide/getting-started
    - theme: alt
      text: See what ships
      link: /features
    - theme: alt
      text: GitHub
      link: https://github.com/aid-framework/aid-framework

features:
  - title: Impossible specs are refused, not debugged
    details: Capability negotiation runs before code is written. A streaming route for a target that cannot stream, a batch deployment without a pipeline, a cloud and target with no module — each is a named diagnostic with the fix, not a stack trace in production.
  - title: Pinned models, priced calls
    details: A model alias resolves to an exact pinned id, never a floating vendor default. Cost profiles price every call and a budget gate compares the configured ceiling with the recorded total.
  - title: Guardrails are a build-time contract
    details: The security gate refuses a POST route that passes caller text to a prompt with no input guardrail. The check happens at generation time, so an unprotected endpoint cannot quietly ship.
  - title: Evals gate like tests
    details: An eval with gate.ci declares a regression budget over a dataset, not a dashboard. aid eval runs it and exits non-zero when the budget is exceeded.
  - title: Infrastructure from the same spec
    details: A deployment plan emits OpenTofu for AWS or GCP, beside a Dockerfile and generated CI. Modules are byte-asserted against fixtures and validated with tofu in CI, so the HCL is proved before you apply it.
  - title: You keep the app
    details: Output is ordinary FastAPI or Next.js code. The generator owns app/generated/, never touches app/business/ after seeding it, and a manifest of hashes makes drift visible. There is no server to adopt and no request proxy.
---

## What goes in, what comes out

You write the part that is actually yours: one spec, the prompt text and the tool bodies.
Everything between the spec and a deployable service is generated, gated and reproducible.

```yaml
specVersion: "0.2"

models:
  fast:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY

prompts:
  greet:
    model: fast
    template: Reply in one sentence to: {{ message }}

pipelines:
  hello:
    trigger:
      http: { method: post, path: /hello }
    steps:
      - generate: { prompt: greet, input: { message: "{{ event.message }}" }, as: reply }
      - emit: { event: Reply }
```

`aid gen` turns that into a typed request and response contract, the route, a prompt
registry entry, a gateway with the model pinned and priced, the pipeline module and the
guardrail engine — then refuses to overwrite a generated file you edited by hand.

## The gates are the product

| Gate | What it catches | What breaks without it |
| --- | --- | --- |
| Capability | A target that cannot honour a declared feature, such as streaming on a target with no SSE surface | A route that compiles and fails on its first real request |
| Security | A POST route that passes caller text to a prompt with no input guardrail | An endpoint exposed to prompt injection on day one |
| Cost | An eval that declares a budget for a model with no cost profile, or an estimated run cost above that budget | A budget that cannot be enforced, and a cost regression that ships unnoticed |
| Eval coverage | An HTTP pipeline with no CI eval claiming it | A prompt edit that silently regresses quality |
| Deploy and infra | An unknown cloud, a cloud and target pair with no module, or streaming on an HTTP API | Unvalidated HCL and a failure during apply |

Each gate names the field and the fix. A spec that cannot work is rejected before any code is
written, and the same gates run again in the generated CI.

## 60-second quickstart

```bash
npx @aid-framework/cli init my-app
cd my-app
npx @aid-framework/cli validate
npx @aid-framework/cli gen
```

```console
$ aid init my-app
created app/app.spec.yaml
created README.md
next: aid validate, then aid gen

$ aid validate
app/app.spec.yaml: ok (0 errors, 0 warnings)
```

`init` writes the smallest legal spec and `gen` writes the generated tree beside it in
`app/generated/`. [Getting started](guide/getting-started.md) adds one guarded pipeline,
shows every file `gen` wrote and serves the endpoint. You need Node.js 24 or newer — no
account, no email gate, nothing else to install.

Seven packages on npm and one on PyPI ship together at version **{{ AID_VERSION }}**, with
the spec language at `0.14`.

## Support, read from the code

The provider, cloud and target matrix is generated from `SERVED_PROVIDERS` and
`CLOUD_TARGETS`, the same declarations the compiler enforces, so the page cannot claim a
provider or a cloud that has not shipped. The [support matrix](reference/support.md) is the
source of truth; a pair it does not cover is refused at plan time with a named diagnostic.

The [features page](features.md) is the short version for a decision: which managed service
runs each deployment target on each cloud, which capabilities every model provider's adapter
advertises, the cloud identity the generated infrastructure grants the service, what ships
out of the box with the release that first shipped it, and what the framework refuses on
purpose with the diagnostic that enforces the refusal.

## What AID is not

- **Not a runtime platform.** There is no proxy and no hosted control plane. The emitted app
  is plain FastAPI or Next.js beside a small runtime library.
- **Not every target on every cloud.** Unsupported pairs are refused rather than
  approximated, and the generated matrix says which pairs exist today.
- **Not a no-code builder.** Prompts, tool bodies and business rules are yours. The
  framework removes the plumbing, not the engineering.
- **Pre-1.0.** A minor release may still change an interface, and a command that is
  specified but not built is listed as such in the CLI reference rather than implied to work.

## Keep the app

| The framework owns | You own |
| --- | --- |
| The spec language, the IR, the gates, the generators and the generated CI | The spec, the prompt text, the tool bodies and app/business/ |
| app/generated/ — rewritten on every gen | app/business/ — seeded once, never touched again |
| The decision that a spec is deployable | The deploy itself, and the cloud account it lands in |

Need to stop using the generator? `aid eject` transfers ownership of the generated tree to
you. The app keeps booting because it never depended on a control plane.

## Where to go next

- New here? [Getting started](guide/getting-started.md) scaffolds, validates, generates and
  serves an app, and shows the two gates that will stop you on the way.
- Want the mental model? [Concepts](guide/concepts.md) is the shortest path through the
  spec, the IR, the generator and the runtime.
- Want a worked example? [Support copilot](walkthroughs/support-copilot.md) walks a
  five-step pipeline with retrieval, an agent and two evals, line by line.
