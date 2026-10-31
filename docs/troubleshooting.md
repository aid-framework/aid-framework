---
description: "Sharp edges reproduced on this repository, including the cases where validate passes and gen refuses, and what each error actually means."
---

# Troubleshooting

The sharp edges below were all reproduced on this repository, and each one says what the tool
actually does rather than what it ought to do. Where a behaviour is a defect rather than a design
choice, it is labelled as one so you can recognise it when you hit it.

## `validate` says ok, and `gen` refuses

This is the most common surprise, and it is a placement issue rather than a spec mistake. Some rules
live in the **target's plan compiler**, not in the IR gate registry, so `aid validate` has no opinion
about them and `aid gen` is the first thing to say no.

Three measured cases:

| Rule | What triggers it | Reported at |
| --- | --- | --- |
| `unsupported-streaming` | An `output`-stage guardrail on a deployment with `streaming: true`. | `deployments.<name>.streaming` |
| `missing-cost` | A model with no `costProfile` whose `modelId` is not in the pinned catalog. | `models.<name>.costProfile` |
| `unsupported-agent` | An agent whose own model, or a model reached through its fallbacks, resolves no price. | `models.<name>.costProfile` |

Each of those returns `ok (0 errors, ...)` from `aid validate`. Treat `gen` - not `validate` - as
your CI pre-flight until the placement is fixed.

## A pipeline must end in `emit`

Every pipeline needs a final `emit` naming the event it returns. Leave it out and the wiring holds
up through validation and then crashes in the emitter:

```console
$ aid gen app/app.spec.yaml --target py-fastapi
aid: internal error in `gen`: internal: an emit step for pipeline 'answer_message' is missing after
validation; this is a generator bug
$ echo $?
2
```

That is a defect: a missing `emit` should be a diagnostic with a path, not an internal error. Until
it is fixed, the workaround is the same as the cause - end the pipeline with `emit`.

## Drift: the hint names a command that does not exist

Edit a generated file and the next `aid gen` refuses to overwrite it, with a message like:

```text
"app/generated/routes/answer_ticket.py" was modified after generation (recorded <sha>, found <sha>).
hint: Run `aid eject app/generated/routes/answer_ticket.py` to own the file, or regenerate with
--force to discard the edits. The new content is written to app/generated/rejected/....
```

`aid eject` is specified and **not implemented** - the CLI has five commands and it is not one of
them. Use `--force` to discard your edit, or move the change into the spec (or into a business-owned
file) so regeneration cannot touch it. The rejected content is written to disk either way, so the
edit is not lost.

## An agent needs a priced model

An agent's model must resolve a price, because `maxCostBudget` cannot be enforced against one that
does not. `provider: fake` models are typically unpriced, so an agent cannot fall back to one - which
is why `examples/support-copilot` gives its agent a model with no fallback chain.

## `npx aid` is not found

The binary is called `aid`, but the package is scoped, so the invocation is:

```bash
npx @aid-framework/cli gen app/app.spec.yaml
```

## No API key

`provider: fake` models run with no key and no network, and the examples fall back to one so the
whole path runs in CI. If you point a model at a real provider without its `apiKeyEnv` set, expect a
failure at request time, not at `gen` - generation never calls a model.

## A `400` is not an outage

When a route answers `400`, a guardrail made a decision and its `onFail.message` is the body. A
failure to reach a model or a tool is a different class and is not a `400`. If you are deciding
whether to retry, that distinction is the one to use - see [Serving](guide/serving.md).

## Reading the exit code in CI

| Code | Meaning |
| --- | --- |
| `0` | Done, and the project is in the shape you asked for. |
| `1` | The project said no - spec, gate, target compiler or working tree. |
| `2` | Your invocation was wrong, or the CLI could not judge the project at all. |

`2` is never "fix your YAML". It is usually a misspelled flag, a missing interpreter, or an
invocation that cannot be judged - so a CI step that treats `2` like `1` will send the next reader to
the wrong file.
