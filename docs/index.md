---
layout: home

hero:
  name: AID Framework
  text: One YAML spec. A production AI service.
  tagline: Build one governed AI service, then repeat it per customer without forking. One declarative spec compiles to FastAPI or Next.js code you own, and build-time gates refuse an unsafe or impossible spec before any code exists.
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
    details: You find out at build time, not in production. Streaming on a target that cannot stream, a batch deployment with no pipeline, a cloud and target with no module — each is a named diagnostic with the fix.
  - title: Know what a run costs before you ship it
    details: A model alias resolves to one pinned id, never a floating vendor default, and a cost profile prices every call so the budget gate compares the declared ceiling with the recorded total.
  - title: Unprotected endpoints cannot ship
    details: The security gate refuses a POST route that passes caller text to a prompt with no input guardrail, so the check happens at generation time instead of during an incident review.
  - title: Evals gate like tests
    details: A quality regression fails the build, not a dashboard. An eval declares a regression budget over a dataset, and `aid eval` exits non-zero when the budget is exceeded.
  - title: Infrastructure from the same spec
    details: The cloud you already use, written for you. A deployment plan emits OpenTofu for AWS or GCP beside a Dockerfile and generated CI, byte-asserted against fixtures and validated with tofu in CI.
  - title: You keep the app
    details: Output is ordinary FastAPI or Next.js code. The generator owns app/generated/, never touches app/business/ after seeding it, and a manifest of hashes makes drift visible. No server to adopt, no request proxy.
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

## One spec, many customers

The base names what a customer is allowed to decide. An overlay may move nothing else.

```yaml
# app/app.spec.yaml — abridged; the rest of the base is the example above
overridable:
  deployments.prod.region:
    from: [eu-central-1, us-east-1, ap-southeast-2]
  models.triage.modelId:
    from: [gpt-4o-mini, gpt-4.1-mini]
  agents.triage_agent.maxCostBudget:
    max: 2.5
  deployments.prod.audit.retentionDays:
    max: 730
```

```yaml
# customers/acme.yaml — one customer's differences
base: ../app/app.spec.yaml
customer: acme-eu
profile: enterprise
overrides:
  deployments.prod.region: ap-southeast-2
  models.triage.modelId: gpt-4.1-mini
  agents.triage_agent.maxCostBudget: 1.5
```

```console
$ aid resolve customers/acme.yaml --out customers/acme.spec.yaml
wrote customers/acme.spec.yaml (3 overrides applied)
$ aid resolve customers/bad.yaml --check
error: the overlay gate rejected "acme-bad": 4000 exceeds the 730 the base allows at "deployments.prod.audit.retentionDays" [overlay/value-out-of-bounds]
$ aid fleet
  customer  profile     models        region          ceiling  status
  acme-eu   enterprise  gpt-4.1-mini  ap-southeast-2  $1.50    ok
```

## Built for

- **Mid-size teams.** `profile: standard`, managed services, default budgets, and the
  [`support-copilot` golden path](reference/cli.md#init) that passes every gate as it lands.
- **Enterprise.** Declared identity, a private network, an audit sink, change approvals, and
  [one overlay per customer](walkthroughs/overlays-and-fleet.md) so one reviewed base stays
  the only source of truth.

## What the compiler writes for you

AID is not a prompt wrapper. Each family below is declared in the spec, then generated,
priced and gated. The count is generated from the release registry rather than typed here,
so a row cannot claim more than shipped; the [features page](features.md) lists every entry
behind these counts.

<!-- capability-band:start -->

| Capability | Declared by | What it covers | Shipped |
| --- | --- | --- | --- |
| **[Model routing and cost](./reference/spec.md#model)** | `models[]` | Every call is pinned and priced, so a budget is a number the build can enforce rather than a hope. | 5 |
| **[Retrieval and memory](./reference/spec.md#retriever)** | `retrievers[], stores[]` | Answers cite the file and offset they came from, whether the source is a managed knowledge base, an object prefix or a local store. | 8 |
| **[Guardrails and decisions](./reference/spec.md#guardrail)** | `guardrails[], decisions[]` | An unprotected route is refused before it exists, and a judgement can be a checked decision instead of prose. | 6 |
| **[Quality gates](./reference/spec.md#eval)** | `evals[]` | A quality regression fails the build, and every route that reaches users has an eval claiming it. | 8 |
| **[Agents and tools](./reference/spec.md#agent)** | `agents[], tools[]` | The plumbing is generated and the tool bodies stay yours; a loop that could run unbounded or unpriced is refused. | 4 |
| **[Deployment and infrastructure](./reference/targets.md#capability-matrix)** | `deployments[], aid infra` | The Dockerfile, OpenTofu or CDK and CI your cloud needs, plus the profile, region, audit sink and approvals an enterprise review asks for. | 9 |
| **[Observability and cost](./reference/cli.md#trace)** | `traces[], observability, aid cost, aid report` | Traces and costs leave only for the collector your policy names, alarms are generated infrastructure, and one report compares every customer. | 6 |
| **[Fleet repeatability](./reference/cli.md#fleet)** | `overridable, aid resolve, aid fleet` | One reviewed base spec, one small overlay per customer: only paths the base opened can move, and the fleet is one command over git. | 4 |

<!-- capability-band:end -->

The point is what does not get written by hand. A service of this shape is normally a
week of plumbing before the first useful line of logic:

| You would otherwise write | The spec declares | What comes out |
| --- | --- | --- |
| A client per provider, the pinned model id, retries, and a price table that drifts | `models: { fast: … }` | A gateway that pins the id, prices each call and traces it |
| A chunker, an index, and citation offsets threaded into the response | `retrievers: [{ kind: vertex-rag }]` | Retrieval wired to the managed store, with path and offsets on every hit |
| The input/output policy and its failing action, once per route | `guardrails: [{ stages: …, onFail: … }]` | One policy engine, with the routes that skip it refused |
| A Dockerfile, and `main.tf` for whichever cloud the customer named | `deployments: [{ target: container }]` | A Dockerfile, and OpenTofu under `infra/` for the cloud `aid infra --cloud` names |
| An eval harness, a budget check, and app CI to run both | `evals: [{ dataset: …, budget: … }]` | A generated CI job that re-runs every gate and fails the build |
| A copy of the spec per customer, and a reviewer to diff them | `overridable` paths, plus one overlay per customer | A resolved spec per customer that only the reviewed paths can move |

[The features page](features.md) lists the same capabilities one by one, with the release
that first shipped each and the refusal that proves it is enforced. Every row on the band
links to the spec section that declares it.

## The gates are the product

| Gate | What it catches | What breaks without it |
| --- | --- | --- |
| Capability | A target that cannot honour a declared feature, such as streaming on a target that cannot stream | A route that compiles, deploys, and fails on its first real user request |
| Security | A POST route that passes caller text to a prompt with no input guardrail | An endpoint open to prompt injection from the day it ships |
| Cost | An eval that declares a budget for a model with no cost profile, or an estimated run cost above that budget | A budget nobody can enforce, and a cost regression that reaches customers unnoticed |
| Eval coverage | An HTTP pipeline with no CI eval claiming it | A prompt edit that quietly makes answers worse, with nothing to catch it |
| Deploy and infra | An unknown cloud, a cloud and target pair with no module, or streaming on an HTTP API | An apply that fails under deadline, on infrastructure nobody validated first |

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

Seven npm packages and one on PyPI ship together at version **{{ AID_VERSION }}**.

## Support

AWS and GCP run `batch`, `container` and `serverless`; `edge` is AWS only. Model providers
are `anthropic`, `bedrock`, `gemini`, `google`, `openai` and `openai-compatible`. The
[support matrix](reference/support.md) is generated from the same declarations the compiler
enforces, so a pair it does not list is refused at plan time with a named diagnostic.

## What AID is not

- **Not a runtime platform.** There is no proxy and no hosted control plane. The emitted app
  is plain FastAPI or Next.js beside a small runtime library.
- **Not every target on every cloud.** Unsupported pairs are refused rather than
  approximated, and the generated matrix says which pairs exist today.
- **Not a no-code builder.** Prompts, tool bodies and business rules are yours. The
  framework removes the plumbing, not the engineering.

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
- Delivering it to a second customer? [Overlays and the fleet table](walkthroughs/overlays-and-fleet.md)
  turns one base spec into one file per customer, and prints the table.
- Want to know how each capability is used? [Usage](usage.md) is one worked example per
  family: the spec fragment, the files it generates, and the refusal that enforces it.
- Want a worked example? [Support copilot](walkthroughs/support-copilot.md) walks a
  five-step pipeline with retrieval, an agent and two evals, line by line.
