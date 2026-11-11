---
description: "A 0.27 enterprise spec that promises an audit trail it never exports, plus an eval that names an agent no runner can score, refused by named diagnostics and then fixed."
---

# Walkthrough: trace export and agent evals

Spec 0.27 adds two things a delivery team asks for: a way to say **where traces go**, and a way for
an eval to **name an agent**.

Both are gated, and both have a spelling that looks reasonable and is refused. An enterprise document
can declare every control from 0.26 — identity, a private network, audit retention, approvals — and
still keep every span inside the process. An eval can point at an agent, which parses and reads
naturally, and cannot be scored by any runner this build ships.

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

The second thing 0.27 adds is the syntax to say an eval is about an agent:

```yaml
evals:
  adjudicator_trajectory:
    target: agent:claims_adjudicator
```

It parses, and the schema accepts it — the coverage gate merely declines to count it toward the
`pipeline:refund` route, which is the warning below. The refusal itself is specific:

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: 1 error(s), 1 warning(s)
claims-desk.spec.yaml: error: the trajectory gate rejected "adjudicator_trajectory": target "agent:claims_adjudicator" names an agent, and this build emits evals over a prompt, not over an agent run [ir/eval-trajectory]
    at evals.adjudicator_trajectory.target
    hint: evaluate the pipeline that runs the agent (`target: pipeline:<id>`) for now; the runtime carries a trajectory, but no generator emits an agent eval yet
claims-desk.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "refund" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.refund
    hint: add an eval targeting "pipeline:refund" and set gate.ci: true
```

This is the design decision worth naming. Before 0.27 the spec language could only express
`pipeline:<id>`, so an agent could not be named at all. Accepting the syntax and then failing later
would be worse than refusing it: the eval runner hands a metric the response string the pipeline
returned. There is no trace of which tools ran, in which order, at what cost. An `agent:` target
scored by `exact` or `llm-judge` would silently grade the final text and print a green check beside
the word "trajectory".

So the refusal happens at the IR, before a generator is entered, and it names the missing piece
— *a generator that emits an agent eval* — rather than reporting a phantom undeclared subject.
The runtime half exists: `aid-runtime-python` lets a runner return a `RunOutput` carrying a
`Trajectory`, and the `tool-trace` metric scores it. What no generator emits yet is a runner that
reports one for an agent, so the gate still refuses the target rather than promise a comparison
nothing performs.

A pipeline can run an agent (the `agent` step kind), which makes the fix a real one rather than a
downgrade: score the pipeline that runs the agent.

```yaml
evals:
  adjudicator_trajectory:
    target: pipeline:refund
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: ok (0 errors, 0 warnings)
```

## Metrics that measure a trajectory

The same gate guards the metric kinds, so the mistake is available one level down. `tool-trace` is
declarable from 0.27 and has no consumer:

```yaml
    metrics:
      - kind: exact
        field: text
      - kind: tool-trace
        expect: [issue_refund]
```

```console
$ aid validate claims-desk.spec.yaml
claims-desk.spec.yaml: error: the trajectory gate rejected "adjudicator_trajectory": metric 1 compares tool calls, and "pipeline:refund" returns a response with no tool calls to compare [ir/eval-trajectory]
    at evals.adjudicator_trajectory.metrics[1]
    hint: this build scores a trajectory (`ToolTrace`), but no generated runner reports the tool calls a case made: score the response with exact, contains, json-schema, llm-judge or assert
```

Note what is **not** refused. `cost` and `latency` are scored directly: the harness reads the
gateway ledger and the clock around every case and compares each against the declared ceiling, so
the generated workflow fails on a case that spends or takes more than the spec allowed. `tool-trace`
is refused because no generated runner reports the tool calls a case made, and a metric that runs
and is never consulted reports coverage the suite does not have.

Drop the `tool-trace` metric and keep a ceiling measured from the response, and the document passes.

## What this build does not do

Being precise about the boundary is the point of the phase:

- **No exporter is installed.** `export: otlp` is intent and a variable name. Generated services
  depend on the OpenTelemetry *API*, which is already in the runtime; the SDK and the OTLP exporter
  are a host dependency.
- **No dashboards or alerts are generated.** Alerting on cost per customer, eval drift and guardrail
  trigger rate needs a backend AID does not ship.
- **No fleet reporting command.** Aggregating cost, eval and trace summaries across many
  deployments from files is designed in the RFC and not built.
- **No trajectory measurement.** An agent run is not scored. Score its pipeline.

Everything above is recorded as a deliberate non-build in `docs/rfcs/0001-agents-at-scale.md` §10.3
rather than implied by a command that does not exist. The one capability 0.27 ships —
`observability-export` — is counted on the [features page](../features.md), and the eval widening is
counted there as a refusal rather than a capability, because what it adds is a named diagnostic: it
joins the other refusals under [what AID refuses](../features.md#refused-on-purpose).
