---
description: "A 0.27 enterprise spec that promises an audit trail it never exports, refused by a named diagnostic and then fixed, plus the eval target that names an agent and the metric kind that must follow it."
---

# Walkthrough: trace export and agent evals

Spec 0.27 adds two things a delivery team asks for: a way to say **where traces go**, and a way for
an eval to **name an agent**.

Both are gated, and both have a spelling that looks reasonable and is refused. An enterprise document
can declare every control from 0.26 — identity, a private network, audit retention, approvals — and
still keep every span inside the process. An eval that names an agent is accepted by the target that
runs agents offline and refused by the one that does not, and a metric that compares tool calls is
refused anywhere there are no calls to compare.

Every console block below is real output from this repository's CLI.

## The spec

Start from an enterprise claims desk whose agent can issue refunds:

```bash
cp ../../packages/spec/test/fixtures/valid/v27-observability.spec.yaml claims-desk.spec.yaml
```

Remove its `observability` block and its agent target, and two older refusals surface first — AID has
always refused a side-effecting tool anyone can call, and refused one no guardrail covers:

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 3 error(s), 0 warning(s)
claims-desk.spec.yaml: error: the guardrails gate rejected "issue_refund": the tool has sideEffects "write" but no declared guardrail covers it at the "tool-call" stage [ir/guardrail-coverage]
    at tools.issue_refund.sideEffects
    hint: add a guardrail with stages: [tool-call] whose tools list is empty or names "issue_refund"
claims-desk.spec.yaml: error: the observability gate rejected this deployment: profile enterprise promises an audit trail, but observability exports nothing, so every span stays inside the process [ir/observability-export]
    at observability.export
    hint: add `observability: { trace: true, export: otlp, endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT }`; the variable holds the collector address, and AID installs no exporter for you
claims-desk.spec.yaml: error: the security gate rejected this tool: "issue_refund" has sideEffects "write" but declares no auth, so it is callable by anyone [ir/security-missing-auth]
    at tools.issue_refund.auth
    hint: declare a policy such as isAuthenticated() and hasScope('x')
```

The third is the 0.27 refusal. An `enterprise` profile is a promise that a record of what the system
did leaves the process; a `container` deployment with `audit.sink: cloudwatch` and 400 days of
retention does not keep that promise on its own. Satisfy the other two the way the
[delivery controls](delivery-controls.md) walkthrough does, and the enterprise refusal is what is
left:

```yaml
tools:
  issue_refund:
    # ...
    auth: hasScope('claims:write')

guardrails:
  toolcall:
    stages: [tool-call]
    policies: [pii-detect]
    action: block
    onFail:
      message: The claim payload was rejected by the tool-call guardrail.
      log: true
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: error: the observability gate rejected this deployment: profile enterprise promises an audit trail, but observability exports nothing, so every span stays inside the process [ir/observability-export]
    at observability.export
    hint: add `observability: { trace: true, export: otlp, endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT }`; the variable holds the collector address, and AID installs no exporter for you
```

## Declaration is not transport

The hint is a shape, not a fix, and 0.27 is deliberately narrow about what `export: otlp` means. It
states an **intent** and names the variable holding the collector address. It does not install an
OpenTelemetry exporter, add a dependency to the generated project, or write collector configuration.
Installing one stays a host decision, because a generated service should not grow a telemetry
dependency it never asked for. What AID does guarantee is that the declaration cannot drift from the
code: `trace` and `redact` are emitted into the generated span writer, `export: otlp` and its
variable are recorded in the IR, and an `enterprise` document cannot be quietly missing either half.

So add the intent on its own and the document is refused for saying half of it:

```yaml
observability:
  export: otlp
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml:96:1: error: missing required property 'endpointEnv' [spec/schema-violation]
    at observability.endpointEnv
```

`export` and `endpointEnv` require each other rather than defaulting. A default would be **a
guessed collector** — a span exporter quietly pointed at whatever `localhost:4317` happens to be, or
at nothing at all, in a document that believes it is exporting. Neither side is inferred.

Name the variable and it is refused in the other direction, because exporting nothing is not
exporting:

```yaml
observability:
  trace: false
  export: otlp
  endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: error: the observability gate rejected this document: it declares `export: otlp` while `trace` is false, so there is nothing to export [ir/observability-export]
    at observability.export
    hint: set `trace: true` to record the spans you are exporting, or `export: none` to keep them in the process
```

The hint offers both readings, because both are honest: turn recording on and export it, or turn
export off and keep the spans local. What it does not accept is the contradiction.

Declare both sides consistently and the document passes:

```yaml
observability:
  trace: true
  export: otlp
  endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT
  redact:
    - subject
    - authorization
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: ok (0 errors, 0 warnings)
```

That block is **process-wide**. It is declared once, on the document, and not on a pipeline:
observability is a property of the process that emits spans, not of one route. `redact` names the
attribute paths dropped before a span leaves, and it is independent of `export` — a service that
keeps traces in the process still benefits from not recording a claim subject in an attribute.

## An eval that names an agent

The second thing 0.27 adds is the syntax to say an eval is about an agent. Declare it alongside the
metric only an agent can satisfy — `tool-trace`, which compares the calls a run made:

```yaml
evals:
  adjudicator_trajectory:
    target: agent:claims_adjudicator
    dataset:
      source: file
      uri: evals/adjudicator_trajectory.jsonl
    metrics:
      - kind: exact
        field: text
      - kind: tool-trace
        expect: [issue_refund]
    gate:
      ci: true
      maxRegression: 0.05
      minMean: 0.8
```

Whether that is accepted is decided by the target, and the [targets](../reference/targets.md) matrix
records which ones declare `agent-evals`. `py-fastapi` does, so it emits an offline evaluator that
runs the agent against each case and scores the calls it made:

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: ok (0 errors, 1 warnings)
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
```

The remaining warning is the coverage gate, not the trajectory gate, and it is the honest one: an
eval over an agent does not cover the pipeline that reaches it, so a document that runs an agent and
serves it over HTTP needs both. The committed example does exactly that — `examples/support-copilot`
declares `target: agent:refund_agent`, and its tree carries
`app/generated/evals/refund_trajectory.py`.

`ts-vercel` does not declare `agent-evals`, so the same eval is refused before a generator is
entered. The gate judges a target by what it declares, and `agents` alone is not the promise: a
target can emit the agent loop without emitting anything that runs one offline.

What a trajectory scored this way measures is worth stating plainly, because the name invites the
wrong reading. The evaluator drives the agent with a scripted or recorded model, so a case verifies
the **policy and plumbing** of a run — which tools were reachable, in what order they were called,
whether an approval was respected, what the run cost — and not the quality of a model's answer. Model
quality is what the prompt and pipeline evals are for, and what a run recorded against a real
provider measures.

## Metrics that measure a trajectory

The gate also guards the metric kind, so the same mistake is available one level down. `tool-trace`
compares the calls a run made, and a pipeline returns a response with no calls to compare:

```yaml
evals:
  adjudicator_trajectory:
    target: pipeline:refund
    metrics:
      - kind: exact
        field: text
      - kind: tool-trace
        expect: [issue_refund]
    gate:
      ci: true
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 0 warning(s)
claims-desk.spec.yaml: error: the trajectory gate rejected "adjudicator_trajectory": metric 1 compares tool calls, and "pipeline:refund" returns a response with no tool calls to compare [ir/eval-trajectory]
    at evals.adjudicator_trajectory.metrics[1]
    hint: a prompt or pipeline target returns one response, so it has no trajectory: score the calls an agent makes with `target: agent:<id>`, or score the response with exact, contains, json-schema, llm-judge or assert
```

Note what is **not** refused. `cost` and `latency` are scored directly: the harness reads the gateway
ledger and the clock around every case and compares each against the declared ceiling, so the
generated workflow fails on a case that spends or takes more than the spec allowed. `tool-trace` is
refused on a pipeline only because a pipeline has no calls to report, and a metric that runs and is
never consulted reports coverage the suite does not have.

Before 0.27 the spec language could only express `pipeline:<id>`, so the only available fix was to
score the pipeline that ran the agent and lose the trajectory with it. The hint now points the other
way: keep `target: agent:<id>` and let the evaluator report the calls, which is what the first half
of this walkthrough validates.

## What this build does not do

Being precise about the boundary is the point of the phase:

- **No exporter is installed.** `export: otlp` is intent and a variable name. Generated services
  depend on the OpenTelemetry *API*, which is already in the runtime; the SDK and the OTLP exporter
  are a host dependency.
- **No dashboards or alerts are generated.** Alerting on cost per customer, eval drift and guardrail
  trigger rate needs a backend AID does not ship.
- **No fleet reporting command.** Aggregating cost, eval and trace summaries across many
  deployments from files is designed in the RFC and not built.

Everything above is recorded as a deliberate non-build in `docs/rfcs/0001-agents-at-scale.md` §10.3
rather than implied by a command that does not exist. The capabilities 0.27 ships —
`observability-export` and, since 0.1.158, `agent-trajectory-evals` — are counted on the
[features page](../features.md) rather than left to a walkthrough to assert. The refusals shown above
join the others under [what AID refuses](../features.md#refused-on-purpose), and the eval widening is
counted twice over: as the capability it is, and as the diagnostic that names the target which cannot
carry it.
