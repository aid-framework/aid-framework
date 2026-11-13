---
description: "How an eval becomes a gate: a pipeline, a dataset, at least one metric, and a statistical comparison against a committed baseline."
---

# Eval metrics

An eval names what it measures — a pipeline, a prompt or an agent — a dataset, and at least one
metric, and it compares the result against a committed baseline. Two things make it a gate rather
than a benchmark: the comparison is statistical, and a metric that calls a model can never be part
of it.

## The `evals` entry

```yaml
evals:
  classify_quality:
    target: pipeline:classify
    dataset:
      source: file
      uri: app/evals/classify.jsonl
    metrics:
      - kind: json-schema
        schema: TicketCategory
      - kind: exact
        field: category
    gate:
      ci: true
      maxRegression: 0.05
      samples: 5
      minMean: 0.9
```

`target` is `pipeline:<id>`, `prompt:<id>` or `agent:<id>`. A `pipeline:` or `prompt:` target has to
resolve to exactly one prompt on one model, and one that renders several is refused with a message
naming them. An `agent:` target runs the agent through its own loop, so what gets scored is the run
itself - its steps, tool calls, spend and approval decisions - and it requires spec 0.27 or later.
`dataset.source` is `file` today, with `uri` required. The `gate` object is optional and defaults to
`samples: 5`, `maxRegression: 0`, `ci: false`, and no `minMean`. An agent case may also carry
`approvals`: an ordered list of `approve` or `reject` decisions, consumed one per pause, so a
trajectory run can reach a human-in-the-loop pause without a person. An absent list means the case
must not pause.

## The nine metric kinds

| `kind` | Fields | Scores |
| --- | --- | --- |
| `exact` | `field` | The prediction's field equals the case's. |
| `contains` | `field`, `value`? | The field contains `value`, or the case's field if omitted. |
| `json-schema` | `schema` | The prediction validates against a declared `types` entry. |
| `tool-trace` | `expect[]`, `ordered`? | The named tools were called; in that order only if `ordered: true`. |
| `cost` | `max` | USD per case did not exceed `max`. |
| `latency` | `maxMs` | Wall-clock milliseconds per case did not exceed `maxMs`. |
| `retrieval` | `expectDocs[]`, `k` | Every listed source path appears in the top `k` ranking. |
| `assert` | `expr`, `message` | A closed predicate over `prediction`, `case.id` and `case.metadata.<name>`. |
| `llm-judge` | `rubric`, `field`?, `model`?, `threshold`? | A model scores the answer against the rubric. |

> **A scripted or recorded trajectory eval checks policy, not model quality.** The `agent:` target
> and the `tool-trace` metric score the tool calls a run actually made: which tools, in what order,
> how many steps, what it spent. When a scripted or recorded provider drives the run, those calls are
> fixed before it starts, so a green result says the step ceiling stopped the run, the tool allow-list
> held, a rejected approval blocked the call, and the spend was attributed. It does not say a real
> model would choose those calls, and a regression budget over such a suite cannot detect a model that
> got worse - only plumbing that broke. A real-model trajectory suite is a separate, later capability.

`retrieval` compares against **known-correct source paths**, spelled relative to the retriever's
`uri`. It is a hit-in-top-`k` check, not a graded ranking metric. `assert` has the most restrictive
grammar in the spec: **no `eval`, no regex**, because a predicate that can execute arbitrary code is
not a predicate. Its `message` is required, and it is printed verbatim on failure - that string is
the entire value of a failing assertion.

## Determinism is the dividing line

Every metric declares whether it is deterministic, and the gate reads that flag rather than a kind
name. `llm-judge` reports `false` and the module says it "must stay that way". It is permitted in
the spec because it is genuinely useful locally, and a spec-local rule **refuses it when
`gate.ci` is true**: a judging model is neither deterministic nor available offline. The schema says
this in the `llm-judge` description itself, and `retrieval` and `assert` are annotated the other
way round - *"deterministic and offline, so unlike llm-judge it is allowed under gate.ci."*

So the rule is not "don't use judges". It is "never make CI depend on one."

## How a gate decides

The ratified design is **N-run sampling against a stored distribution**, never an equality check.
For each metric:

1. Run the dataset `samples` times, giving one mean score per run. Those means are the sample, and
   their spread is the honest measure of how much the system varies when nothing changed.
2. Compare the sample against the baseline's own mean, spread and size.
3. Fail only when the drop exceeds `maxRegression` **and** the standard error of the difference
   cannot explain it.

Step 3 is the whole design. A gate that fires on any decrease is flaky; a gate that compares only
means is fooled by a noisy run. Requiring both a material and a statistically distinguishable drop
means non-determinism is treated as expected rather than as a bug.

`minMean` is the one absolute test: the eval fails whenever the mean falls below it, regardless of
`maxRegression`. A 0/1 metric such as `assert` needs it, because a regression allowance can
otherwise absorb a drop it must never absorb - which is why a spec-local rule requires
`minMean: 1.0` whenever an `assert` metric is present.

## Baselines

`aid eval --baseline` records the baseline the gate measures against. It delegates the sampling to
the eval module's own recipe rather than re-sampling in the CLI, so the CLI and the module cannot
disagree about how many runs a baseline means. Python's recipe calls `run()` and
`EvalBaseline.from_run`; Node's calls the generated `recordBaseline()`. Either way the module's own
`BASELINE_PATH` decides where the file goes - the same constant `load_baseline()` / `loadBaseline()`
reads back.

A baseline is a recorded run, not a number you type. Recording it twice with nothing changed writes
the same means, and that stability is the property a gate needs: a hand-tuned number is a target,
while a measurement is a description.

The committed files are `app/evals/<id>.baseline.json`. Commit them: a gate with no baseline has
nothing to regress against.

A retrieval baseline is only meaningful over a corpus that was indexed when it was recorded. With a
`kind: memory` store that means recording in the same process that ingests - otherwise the baseline
faithfully records the score of an empty index.

## Coverage

`ir/eval-uncovered` warns when an HTTP-triggered pipeline has no eval with `gate.ci: true`, and it
warns again when a spec declares retrievers and no eval carries a `retrieval` metric.

Under `profile: standard` both are warnings: they appear on a successful `aid validate` and are
meant to be read. Under `profile: enterprise` from spec `0.31` the same code refuses. An enterprise
service that cannot measure its own pipelines has no baseline to regress, so the gate makes the
measurement the condition of the build rather than a suggestion in a review.
