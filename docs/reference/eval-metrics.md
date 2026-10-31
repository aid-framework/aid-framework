# Eval metrics

An eval names a pipeline, a dataset and at least one metric, and it compares the result against a
committed baseline. Two things make it a gate rather than a benchmark: the comparison is
statistical, and a metric that calls a model can never be part of it.

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

`target` is `pipeline:<id>` - **only pipelines are evaluable in Phase 0**. `dataset.source` is
`file` today, with `uri` required. The `gate` object is optional and defaults to
`samples: 5`, `maxRegression: 0`, `ci: false`, and no `minMean`.

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
disagree about how many runs a baseline means. The module's own `BASELINE_PATH` decides where the
file goes - the same constant `load_baseline()` reads back.

The committed files are `app/evals/<id>.baseline.json`. Commit them: a gate with no baseline has
nothing to regress against.

## Coverage

`ir/eval-coverage` warns when an HTTP-triggered pipeline has no eval with `gate.ci: true`, and it
warns again when a spec declares retrievers and no eval measures them. Both are warnings, not
failures - they appear on a successful `aid validate` and are meant to be read.
