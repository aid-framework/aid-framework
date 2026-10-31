---
layout: home

hero:
  name: AID Framework
  text: Declare the service. Keep the business logic.
  tagline: One YAML spec compiled into a Python or TypeScript AI service you own - typed contracts, generated routes, guardrails, evals and retrieval, with the plumbing written for you.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Spec reference
      link: /reference/spec
    - theme: alt
      text: GitHub
      link: https://github.com/aid-framework/aid-framework

features:
  - title: One spec, two stacks
    details: The same spec targets py-fastapi and ts-vercel. The spec is lowered to a stack-independent IR, gated, and then applied through a generator plugin, so cross-target differences are a declared capability matrix rather than an accident.
  - title: Generated, then owned by you
    details: Everything lands in app/generated/ and app/business/. The generator rewrites the first and never touches the second after seeding it, and a manifest of hashes makes drift detectable instead of silent.
  - title: Guardrails are a build-time contract
    details: A guardrail is enforced inline by the route it applies to, and the security gate refuses a spec that passes caller text to a prompt with no input guardrail. The check happens at gen time, not review time.
  - title: Evals gate like tests
    details: An eval with gate.ci declares a regression budget over a dataset, not a dashboard. aid eval runs it and fails on a regression.
  - title: Retrieval without the glue
    details: Stores, retrievers, chunking, hybrid index, rerank and citation traits are declared and generated, including the ingestion step.
  - title: Nothing to adopt at runtime
    details: The output is ordinary FastAPI or Next.js code beside a small runtime library. There is no server to run and no request proxy - delete the framework and the tree still boots.
---

## Pre-alpha, and it says so

Every package here is published — seven on npm
(`@aid-framework/cli`, `@aid-framework/spec`, `@aid-framework/ir`,
`@aid-framework/generator-sdk`, `@aid-framework/generator-py-fastapi`,
`@aid-framework/generator-ts-vercel`, `@aid-framework/runtime`) and one on PyPI
(`aid-runtime-python`) — at version **{{ AID_VERSION }}**. The spec language is at
v0.3, and the two generator targets cover the surface this repository tests.

What that means in practice: the spec surface, the IR and the two generators are
implemented and pinned by a conformance suite (73 cases over 40 operations), but the
project is pre-1.0 and the CLI has commands that are specified and not yet built. The
[CLI reference](reference/cli.md) lists them separately rather than implying they work.

## The shape of it

A spec is a single YAML file. Models, prompts, tools, guardrails, pipelines and evals are
declared, and what is left for you to write is the part that is not boilerplate: the prompt
text, the tool bodies, and the decision about what happens when a guardrail fires.

```yaml
models:
  fast:
    provider: openai
    modelId: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY

pipelines:
  hello:
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

`aid gen` turns that into a router, a request model, a response model, a prompt registry
entry, a gateway with the model pinned and priced, a pipeline module and a guardrail
engine - and then refuses to overwrite any of it if you edited it by hand.

## Where to go next

- New here? [Getting started](guide/getting-started.md) scaffolds, validates and generates
  an app, and shows the two gates that will stop you on the way.
- Want the mental model? [Concepts](guide/concepts.md) is the shortest path through the
  spec, the IR, the generator and the runtime.
- Want a worked example? [Support copilot](walkthroughs/support-copilot.md) walks a
  five-step pipeline with retrieval, an agent and two evals, line by line.
- Want the argument? [`design.md`](design.md) is the authoritative design document, and the
  site renders it in place rather than duplicating it.
