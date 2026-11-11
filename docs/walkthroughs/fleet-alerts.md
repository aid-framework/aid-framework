---
description: "A walkthrough of generated alarms: three alert specs the gate refuses — no export, an aggregate the metric cannot answer, an undeclared source — each with its fix, ending in the CloudWatch and Cloud Monitoring policies the plan emits."
---

# Walkthrough: alarms you can only declare, never drift

An `observability` block that records spans is half a promise. The other half is the part that
wakes someone up: **who gets paged when this agent gets expensive or slow**. Today that alarm is
usually a console click nobody reviewed, whose threshold drifts from the budget the spec still
claims to enforce.

`observability.alerts` (spec 0.30) moves it into the document. An alert names a metric, a window,
a reduction and a threshold; `aid infra gen` turns each one into a real
`aws_cloudwatch_metric_alarm` or `google_monitoring_alert_policy`. The alarm is then reviewed in
the same diff as the rest of the plan, and the unit on the page comes from the metric rather than
from whoever typed the threshold.

What makes this more than templating is what the gate refuses. Every console block below is real
output from this repository's CLI.

## The document

An enterprise claims adjudicator, with four alerts: two on the agent (spend and tokens), one on an
eval cost, one on eval latency.

```yaml
specVersion: "0.30"
profile: enterprise
observability:
  trace: true
  export: otlp
  endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT
  redact: [subject, authorization]
  alerts:
    - id: adjudicator_cost
      metric: agent.cost
      window: 15m
      aggregate: sum
      threshold: 25
      source: claims_adjudicator
    - id: adjudicator_tokens
      metric: agent.tokens
      window: 1h
      aggregate: max
      threshold: 120000
      source: claims_adjudicator
    - id: refund_latency
      metric: eval.latency.p95
      window: 6h
      aggregate: p95
      threshold: 4000
      source: refund_exact
    - id: fleet_eval_spend
      metric: eval.cost
      window: 24h
      aggregate: sum
      threshold: 50
```

`aid validate` accepts it:

```console
$ aid validate app/app.spec.yaml
app/app.spec.yaml: ok (0 errors, 0 warnings)
```

Four alerts is not four kinds of alarm. It is one kind, parameterized by four closed enums, and
that closure is where the refusals come from.

## Refusal one: an alarm over a series nobody publishes

The first instinct is that `alerts` is a monitoring concern and `export` is a vendor concern, so
the alert block gets added on its own:

```yaml
observability:
  trace: true
  redact: [subject, authorization]
  alerts:
    - id: adjudicator_cost
      metric: agent.cost
      window: 15m
      aggregate: sum
      threshold: 25
      source: claims_adjudicator
    # ... the other three
```

```console
$ aid validate app/app.spec.yaml
app/app.spec.yaml: 2 error(s), 0 warning(s)
app/app.spec.yaml: error: the alerts gate rejected this document: 4 alert(s) are declared, but observability exports nothing, so no collector derives the series they watch and every alarm would report no data forever [ir/alerts-unexported]
    at observability.alerts
    hint: add `export: otlp` and `endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT` so the spans reach a collector, or remove the alerts block
app/app.spec.yaml: error: the observability gate rejected this deployment: profile enterprise promises an audit trail, but observability exports nothing, so every span stays inside the process [ir/observability-export]
    at observability.export
    hint: add `observability: { trace: true, export: otlp, endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT }`; the variable holds the collector address, and AID installs no exporter for you
```

The diagnostic is doing more than type-checking a required field. An alarm's metric exists only
because a collector published it, and `export: otlp` is the only declaration in the document that
promises a collector is in the path. Without it the alarm is expressible, deploys cleanly, and is
permanently silent — and a silent alarm is worse than no alarm, because a green dashboard is
indistinguishable from a system that is fine.

The fix is to say where the spans go, which is the same statement the enterprise profile was
already asking for:

```yaml
observability:
  trace: true
  export: otlp
  endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT
  alerts: ...
```

Note the second error is a *different* gate reaching the same conclusion from the other direction.
The alerts gate refuses the alarm because nothing publishes its series; the observability gate
refuses the deployment because the enterprise profile promised an audit trail. One `export:` line
satisfies both, which is the sign it was the missing fact rather than two missing fields.

## Refusal two: a reduction the metric cannot answer

`agent.cost` is a sum of money. It is tempting to watch its p95:

```yaml
    - id: adjudicator_cost
      metric: agent.cost
      window: 15m
      aggregate: p95
      threshold: 25
```

```console
$ aid validate app/app.spec.yaml
app/app.spec.yaml: 1 error(s), 0 warning(s)
app/app.spec.yaml: error: the alerts gate rejected "adjudicator_cost": `aggregate: p95` cannot interpret metric "agent.cost" [ir/alerts-aggregate]
    at observability.alerts.adjudicator_cost.aggregate
    hint: use `sum`, `average` or `max`, because "agent.cost" is a quantity and a percentile of it has no definition
```

The gate is not being fussy about vocabulary. It is refusing a number that cannot exist: there is
no 95th percentile of a quantity, only of a distribution over samples, and CloudWatch's
`statistic` enum does not even accept `p95` — a percentile belongs in `extended_statistic`. Had
the gate let this through, the generated HCL would have been rejected by the provider at `tofu
plan`, one layer too late and in a language the author did not write.

Because the rule is `p95` if and only if the metric is a latency, the same mistake in reverse is
also refused:

```yaml
    - id: refund_latency
      metric: eval.latency.p95
      window: 6h
      aggregate: sum
      threshold: 4000
```

```console
$ aid validate app/app.spec.yaml
app/app.spec.yaml: error: the alerts gate rejected "refund_latency": `aggregate: sum` cannot interpret metric "eval.latency.p95" [ir/alerts-aggregate]
    at observability.alerts.refund_latency.aggregate
    hint: use `aggregate: p95`, because "eval.latency.p95" is a percentile series and no other reduction interprets it
```

Fixing either means picking the reduction the metric actually has, which for a total is `sum`,
`average` or `max`, and for a latency is `p95`.

## Refusal three: an alarm scoped to a name nothing declares

`source` narrows an alarm to one agent or one eval, so a fleet-wide spend alarm can be split per
pipeline. It is a plain string, which means it is also a typo waiting to happen:

```yaml
    - id: adjudicator_tokens
      metric: agent.tokens
      window: 1h
      aggregate: max
      threshold: 120000
      source: claims_desk      # the project name, not the agent's
```

```console
$ aid validate app/app.spec.yaml
app/app.spec.yaml: 1 error(s), 0 warning(s)
app/app.spec.yaml: error: the alerts gate rejected "adjudicator_tokens": source "claims_desk" names no agent or eval in this document, so the series it watches never carries that label [ir/alerts-source]
    at observability.alerts.adjudicator_tokens.source
    hint: name a declared agent or eval id, or omit `source` to watch the whole environment
```

`claims_desk` is nearly right — it is the project's name, and it reads as a plausible source.
That is exactly why the gate checks it. A `source` becomes a CloudWatch dimension or a Cloud
Monitoring metric label, and a dimension nothing writes matches no time series, so the alarm sits
in `INSUFFICIENT_DATA` forever and the operator learns to ignore it. Refusing at validate time
turns a permanent silence into a one-line fix: either name the declared id
(`claims_adjudicator`), or drop `source` to watch the whole environment.

## What the plan emits

With all four alerts corrected, `aid infra gen` writes the module:

```console
$ aid infra gen
infra/generated: 19 created, 0 updated, 0 unchanged, 0 kept
  created  infra/generated/README.md
  created  infra/generated/cdk/alerts.cjs
  created  infra/generated/cdk/audit.cjs
  created  infra/generated/cdk/container.cjs
  created  infra/generated/deploy.auto.tfvars.json
  created  infra/generated/deploy.cdk-context.json
  created  infra/generated/deploy.plan.json
  created  infra/generated/modules/alerts/main.tf
  created  infra/generated/modules/alerts/outputs.tf
  created  infra/generated/modules/alerts/variables.tf
  created  infra/generated/modules/alerts/versions.tf
  created  infra/generated/modules/audit/main.tf
  ...
```

The README gains the row that says what the module is for, and the env root gains the two
variables an operator sets rather than the compiler:

```console
$ cat infra/generated/README.md | grep alerts
| `modules/alerts/` | One CloudWatch alarm per `observability.alerts` entry, watching the namespace the collector publishes into. |

$ cat infra/generated/deploy.plan.json | grep -A7 '"alerts"'
  "alerts": [
    {
      "id": "adjudicator_cost",
      "metric": "agent.cost",
      "window": "15m",
      "aggregate": "sum",
      "threshold": 25,
      "unit": "usd",
      "source": "claims_adjudicator"
    },
```

`unit` is not in the document. It is derived from `metric`, so the number and its label cannot
disagree — `25` is `usd` because `agent.cost` is money, and no author can page on "25 widgets" by
mistake.

The generated resource is ordinary HCL, and the comments record the two decisions a reviewer would
otherwise have to reverse-engineer:

```hcl
resource "aws_cloudwatch_metric_alarm" "adjudicator_cost" {
  alarm_name        = "aid-${var.project.namespace}-${var.project.name}-adjudicator_cost"
  alarm_description = "agent.cost (sum) over 15m exceeded 25 usd for \"claims_adjudicator\". Declared in observability.alerts."

  namespace   = local.metric_namespace
  metric_name = "agent.cost"

  dimensions = {
    Source = "claims_adjudicator"
  }

  period              = 900
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 25

  # One period is one evaluation: the window in the document *is* the period, so a
  # second evaluation would watch a longer span than the author declared.
  evaluation_periods  = 1
  datapoints_to_alarm = 1

  # A pipeline that stopped exporting is not a pipeline that came in under budget.
  treat_missing_data = "missing"

  alarm_actions = var.alert_channel_ids

  tags = var.tags
}
```

Three things there are deliberate:

- **`period` is the window.** `15m` becomes `900` seconds and `evaluation_periods = 1`, so the
  alarm measures exactly the span the author wrote. Averaging over `3 × 5m` would quietly watch a
  different window than the document claims.
- **`treat_missing_data = "missing"`.** The default in many consoles is to treat absent data as
  healthy, which is how an exporter that stopped exporting looks like a system under budget.
- **`alarm_actions = var.alert_channel_ids`, which defaults to `[]`.** A generated alarm notifies
  nobody until an operator names a channel. That is intentional: the compiler knows who should be
  woken up in *your* organisation no more than it knows your account ids, and inventing one would
  page a stranger.

The latency alert is the same resource with one difference — a percentile goes in
`extended_statistic`, because CloudWatch's `statistic` enum has no percentiles:

```hcl
resource "aws_cloudwatch_metric_alarm" "refund_latency" {
  alarm_name        = "aid-${var.project.namespace}-${var.project.name}-refund_latency"
  alarm_description = "eval.latency.p95 (p95) over 6h exceeded 4000 ms for \"refund_exact\". Declared in observability.alerts."
  ...
  period             = 21600
  extended_statistic = "p95"
  comparison_operator = "GreaterThanThreshold"
  threshold          = 4000
```

## The same document on GCP

GCP is not a translation layer over the CloudWatch shape; the emitters differ where the platforms
differ. `--cloud gcp` produces `google_monitoring_alert_policy`, where the window becomes a
`duration`, the reduction becomes a `per_series_aligner` plus a `cross_series_reducer`, and an
undeclared source was already refused at validate time so the label filter is always satisfiable:

```hcl
resource "google_monitoring_alert_policy" "adjudicator_cost" {
  filter          = "metric.type=\"${local.metric_prefix}agent.cost\" AND resource.type=\"global\" AND metric.label.source=\"claims_adjudicator\""
  comparison      = "COMPARISON_GT"

  aggregations {
    per_series_aligner   = "ALIGN_SUM"
    cross_series_reducer = "REDUCE_SUM"
  }
```

The document that produced both is byte-identical. That is the point of the closed metric and
aggregate enums: a spec that validates has a meaning on every target that shipped, rather than one
target and an approximation on the other.

## What this is not

The module does not run an OpenTelemetry Collector, install an exporter in the runtime, or page
anyone. It declares the alarms and wires them to a variable you set. Those remain the honest gaps:
`export: otlp` records where spans belong, and the collector that carries them there is yours to
deploy — which is why `alert_channel_ids` defaults to empty rather than to a guess.

Dashboards are also not generated. Alerts are a closed list of four metrics with a numeric
threshold; a dashboard is an open-ended layout, and a generated one that guessed at the panel that
matters would be worse than the console click it replaced.
