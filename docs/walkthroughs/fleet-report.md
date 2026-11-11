---
description: "A walkthrough of aid report: a path it refuses because it is one trace sink and not a fleet, a root it refuses to call a healthy zero, a customer it refuses to call free, a --budget ceiling it fails, and a baseline it declines to score."
---

# Walkthrough: one report across every customer deployment

`aid report` is `aid cost` at fleet size. `aid cost` answers "what did this deployment's traces
cost", from a directory of spans. `aid report` answers the question a delivery team actually gets
asked — **which of our customers is expensive, slow or erroring** — from a directory that holds one
subdirectory per deployment.

There is no backend. The directory is whatever your CI downloaded: each deployment's trace sink, and
each deployment's recorded eval baseline if there is one. Both file formats already exist — one is
what `aid cost` reads, the other is what `aid eval --baseline` writes — so the report invents no new
artifact and needs no service to be running.

The interesting part is what it refuses to print. A deployment with no traces is not a deployment
that cost nothing, a metric mean is not a number you can round to three decimals whatever its unit,
and a file that is shaped like a baseline but cannot be read is not a score of zero. Every console
block below is real output from this repository's CLI.

## The layout

Three customers' sinks, downloaded into one directory:

```console
$ ls artifacts
acme  quiet-customer  zenith
$ ls artifacts/acme
support.baseline.json  trace-1.jsonl
```

`acme` is measured and has a recorded baseline. `zenith` is measured. `quiet-customer` is a customer
whose sink directory exists but is empty — its agent was never routed any traffic, or its exporter was
never switched on. That turns out to be the most useful row in the table.

The row exists because the download created the directory. A customer whose directory was never
created does not appear at all, which is exactly the failure the empty-root warning below catches.

## Refusal one: a path that is one deployment, not a fleet

The first instinct is to point at the sink you have:

```console
$ aid report artifacts/acme/trace-1.jsonl
aid: "artifacts/acme/trace-1.jsonl" is not a directory.
<spec>: error: "artifacts/acme/trace-1.jsonl" is not a directory. [cli/report-dir-unreadable]
    hint: Point aid report at the directory that holds one subdirectory per deployment. A trace directory with spans directly inside it is what `aid cost` reads, not this.
```

The diagnostic is doing more than type-checking the argument. Reading a single file would print one
deployment's cost under a command whose whole purpose is comparison, and the number would look
exactly as authoritative as a fleet total. The fix names the other command, because pointing at one
sink is a reasonable thing to want — it is just `aid cost` that answers it.

## Refusal two: a root directory that contains no deployments

The next attempt steps up one level, but to a deployment rather than to the fleet:

```console
$ aid report artifacts/acme
dir: artifacts/acme
deployment    spans   traces         cost       p95   errors  evals
measured: no deployment directories here, so no cost, latency or error figures exist to compare.
<spec>: warning: no deployment directories in "artifacts/acme". [cli/report-no-deployments]
    hint: Each immediate child directory is one deployment. An empty report is a true answer, but check that the trace sink was downloaded to the right place.
```

This is the harder case, because the exit code is `0` and the read genuinely succeeded. A tool that
printed `0 spans, $0.00` here would be lying in the most expensive direction: it looks like a healthy
fleet that costs nothing. The warning says which directory was read, what shape it expected, and the
one thing a person should check before believing it.

The table header is still printed and the measured line still explains itself, so the empty answer is
visibly empty rather than silently empty.

## The report

Point it at the directory that holds the deployments:

```console
$ aid report artifacts
dir: artifacts
deployment        spans   traces         cost       p95   errors  evals
acme                  2        2   $18.400000     640ms        0  1 baseline(s): exact_match 0.82, cost_usd 0.0042
quiet-customer        —        —            —         —        —  —
zenith                1        1    $9.100000     520ms        0  —
total: 3 span(s) in 3 trace(s) across 2 of 3 deployment(s), $27.500000
```

Four things in that table are deliberate.

**The dash on `quiet-customer` is not a zero.** Zero dollars and "we never collected a span" are
different facts, and only one of them is safe to put in a budget conversation. The `total:` line says
`2 of 3` for the same reason: a fleet total is an aggregation over what was measured, and the number
of measured deployments belongs next to it rather than in a footnote.

**`acme`'s costs are `$18.400000` and the baseline's are `0.0042`.** The trace cost is a fixed six
decimals, matching `aid cost` byte for byte so two tools never disagree about the same spans. The
recorded mean is four significant digits, because a mean has no declared unit — `exact_match` is a
ratio and `cost_usd` is dollars per run. Three decimals would print that cost as `0.004`.

**Both metrics are shown, comma-separated.** They are not averaged. Averaging an `exact_match` and a
`cost_usd` produces a number that means nothing, so the cell lists what was recorded and lets the
reader compare like for like.

**Only direct children are read.** A deeper walk would attribute a nested span to whichever ancestor
it met first, which is a silently wrong answer about a named customer. If your download nests deeper,
flatten it.

## Refusal three: a ceiling the fleet exceeds

A cost ceiling belongs in CI, where it fails a job:

```console
$ aid report artifacts --budget 25
dir: artifacts
deployment        spans   traces         cost       p95   errors  evals
acme                  2        2   $18.400000     640ms        0  1 baseline(s): exact_match 0.82, cost_usd 0.0042
quiet-customer        —        —            —         —        —  —
zenith                1        1    $9.100000     520ms        0  —
total: 3 span(s) in 3 trace(s) across 2 of 3 deployment(s), $27.500000
budget: $25.000000 (over by $2.500000)
<spec>: error: the fleet's measured cost $27.500000 exceeds the --budget ceiling $25.000000 by $2.500000. [cli/cost-over-budget]
    hint: Either the ceiling is out of date or a deployment is spending more than it should; `aid cost --budget` per deployment narrows down which one.
```

The table still prints before the failure, because a ceiling that fails a job without showing the
per-deployment breakdown makes the next step a manual investigation. The hint then points at the
narrowing command: `acme` alone is `$18.40` of the `$27.50`, so a per-deployment `aid cost --budget`
run tells you in one step whether the ceiling is stale or one customer's usage changed.

`--budget` uses the same flag name, meaning and diagnostics as `aid cost` — `cli/cost-budget-invalid`
for a value that is not a positive number, `cli/cost-over-budget` for an exceeded ceiling. There is
no second vocabulary for the same idea, and a value that will not parse fails before any file is read.

## Refusal four: a file that looks like a baseline but is not one

Someone edits a baseline by hand to record a score:

```console
$ cat artifacts/zenith/stale.baseline.json
{"metrics":[{"metric":"exact_match","mean":0.71}]}
$ aid report artifacts
dir: artifacts
deployment        spans   traces         cost       p95   errors  evals
acme                  2        2   $18.400000     640ms        0  1 baseline(s): exact_match 0.82, cost_usd 0.0042
quiet-customer        —        —            —         —        —  —
zenith                1        1    $9.100000     520ms        0  —
total: 3 span(s) in 3 trace(s) across 2 of 3 deployment(s), $27.500000
<spec>: warning: "zenith/stale.baseline.json" is not a recorded baseline, so its scores are not shown. [cli/report-baseline-invalid]
    hint: A baseline needs dataset, dataset_version and metrics[].{metric,mean}. Regenerate it with `aid eval --baseline` rather than editing it.
```

The file has a metric and a mean. It has no `dataset`, so there is no way to know what
`exact_match 0.71` was measured against, and a score with no dataset is not comparable to anything —
which is the only thing a baseline is for. The report shows a dash and names the file, rather than
printing `0.71` next to `acme`'s `0.82` and inviting a conclusion the data does not support.

The parser is deliberately lenient in the other direction: a baseline written by a newer runtime, with
fields this build has never heard of, is read normally. Refusing a future field would make the report
useless the moment two deployments ran different builds.

## What the report does not do

- **It does not validate specs.** `aid report` reads trace and baseline files. Whether a deployment's
  spec passes its gates is `aid validate` and `aid fleet`, over the repository. The report works on a
  CI download that may not contain a spec at all.
- **It does not join the fleet table.** `aid fleet` lists overlays by a repository naming convention;
  `aid report` lists directories by whatever name the download used. Joining them would make the
  report refuse whenever the two names disagreed, and the two questions are asked at different times
  by different people.
- **It does not reach a backend.** There is no hosted control plane, no ingestion and no database. The
  command's input is files, its output is stdout or `--json`, and the fleet comparison happens on the
  laptop or the CI runner that already has the download.

Machine-readable output is the same data with nothing rendered:

```console
$ aid report artifacts --json
{
  "command": "report",
  "ok": true,
  "dir": "artifacts",
  "deployments": [
    {
      "deployment": "acme",
      "files": 1,
      "spans": 2,
      "traces": 2,
      "costUsd": 18.4,
      "unpricedSpans": 0,
      "errors": 0,
      "p95Ms": 640,
      "baselines": [
        {
          "file": "support.baseline.json",
          "dataset": "support-copilot",
          "datasetVersion": "3",
          "metrics": [
            {
              "metric": "exact_match",
              "mean": 0.82
            },
            {
              "metric": "cost_usd",
              "mean": 0.0042
            }
          ]
        }
      ],
      "skipped": 0,
      "unreadable": 0
    },
    {
      "deployment": "quiet-customer",
      "files": 0,
      "baselines": [],
      "skipped": 0,
      "unreadable": 0
    },
    {
      "deployment": "zenith",
      "files": 1,
      "spans": 1,
      "traces": 1,
      "costUsd": 9.1,
      "unpricedSpans": 0,
      "errors": 0,
      "p95Ms": 520,
      "baselines": [],
      "skipped": 0,
      "unreadable": 0
    }
  ],
  "totals": {
    "deployments": 3,
    "measured": 2,
    "spans": 3,
    "traces": 3,
    "costUsd": 27.5,
    "errors": 0,
    "unpricedSpans": 0
  },
  "unlistable": [],
  "badBaselines": [],
  "diagnostics": []
}
```

The fields that only appear when something is wrong — `skipped`, `unreadable`, `unlistable`,
`badBaselines` — are always present in the JSON and always zero or empty when the read was clean, so
a CI script can assert on them without special-casing a missing key.

## The gate summary

| Diagnostic | When | Exit | The fix |
| --- | --- | --- | --- |
| `cli/report-dir-unreadable` | the argument is not a directory | `2` | point at the directory of deployments, or use `aid cost` for one sink |
| `cli/report-no-deployments` | no immediate child directories | `0` + warning | check where the sink was downloaded; an empty fleet is a real answer |
| `cli/report-baseline-invalid` | a `*.baseline.json` with no `dataset` or a non-numeric `mean` | `0` + warning | regenerate with `aid eval --baseline`; do not hand-edit |
| `cli/cost-budget-invalid` | `--budget` is not a positive number | `2` | pass dollars, e.g. `--budget 40` |
| `cli/cost-over-budget` | the measured total exceeds `--budget` | `1` | raise the ceiling deliberately, or narrow with `aid cost --budget` |

Every one of those refusals is a fact about the input, checked before a summary is printed. None of
them is a guess about intent, and none of them silently substitutes a zero.
