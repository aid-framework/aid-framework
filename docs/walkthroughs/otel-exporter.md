---
description: "A walkthrough of the OTel exporter: a spec that declares a collector, the target that refuses it because it installs no exporter, the fix, and the one line in your own entrypoint that makes the other target send the spans."
---

# Walkthrough: the exporter 0.27 declared but did not install

Spec 0.27 put `export: otlp` in the language. It declared where spans *belong*: a destination, an
environment variable holding the collector's address, and a gate that refused a document whose
export contradicted its tracing. What it did not do was install anything. A document could say
`otlp` and every span still died with the process, because installing an exporter is a runtime
decision and AID had not made one.

This walkthrough is about making that decision, and about the refusal that keeps the declaration
honest in the one target that still cannot honour it. Every console block below is real output from
this repository's CLI, and every file shown is real generated output.

## The document

Start from `examples/support-copilot-ts`, the committed TypeScript example, and add the block:

```yaml
specVersion: "0.30"
```

```yaml
observability:
  trace: true
  export: otlp
  endpointEnv: OTEL_EXPORTER_OTLP_ENDPOINT
```

`aid validate` accepts it. The document is not wrong; the *target* is not able to serve it.

## The refusal

The example's `project.targets` is `[ts-vercel]`, and `ts-vercel` records spans without installing
an exporter. That is what its capability row says -- `otel` is declared, `emitsAgainst.tracing` is
`otel-genai` -- and it is true: the runtime opens spans and fills them. What it never does is open a
connection to a collector.

So the generator refuses, rather than accept an address it will never write to:

```console
$ aid gen app/app.spec.yaml --target ts-vercel --dry-run
<spec>: error: this target records spans but installs no exporter, so `otlp` would name a collector nothing is sent to; generate this document with py-fastapi to export, or declare `export: none` to keep spans in the process [observability-export-unsupported]
    at observability.export
```

Three things about that message are deliberate:

- It is refused at **plan time**, inside `planTsVercel`, not by a check a caller could skip. A gate
  that only ran when someone asked it would leave the default `aid gen` path emitting the
  deployment the gate exists to prevent.
- It names **both** ways out. "This target cannot do that" without a next step is a dead end, so the
  message says which target can, and which declaration is the honest alternative.
- It distinguishes two claims that are easy to conflate. `otel` means *this app records spans*;
  `export` means *this app ships them*. `ts-vercel` makes the first and refuses the second. A
  capability matrix that collapsed the two would have to lie about one of them.

## The fix, if you are staying on this target

Declare that the spans stay in the process, on purpose:

```yaml
observability:
  trace: true
  export: none
```

```console
$ aid gen app/app.spec.yaml --target ts-vercel --dry-run
ts-vercel: dry run, 37 created, 0 updated, 0 unchanged, 0 kept, 1 scaffold kept
```

The document generates. Nothing else moved -- the trees are byte-identical to what they were before
`observability` was declared, because `export: none` is what an absent block already meant.

That is the whole cost of the refusal: a document that wants to export has to name a target that
can.

## The fix, if you want the spans to leave

Use the target that installs the exporter. The same block, generated with `py-fastapi`, is accepted
and adds exactly one file:

```console
$ aid gen app/app.spec.yaml --target py-fastapi --dry-run | grep observability
  app/generated/observability.py
```

That file is generated, so it carries the ownership header and is not yours to edit. Its interesting
part is the second function -- the first is `generated_capabilities()`, which every py-fastapi
example has:

```python
def tracing_export_status(service_name: str) -> ExportStatus:
    """Install the span exporter this document declared, and report what happened. Call it once at
    startup, before serving, from the entrypoint this app owns -- the generator cannot make the call
    for you because it does not own that file. Nothing here raises: an unset endpoint or an
    uninstalled exporter comes back as a status whose `detail` names the fix, because telemetry that
    cannot start must not stop the service from serving.
    """

    return configure_export(
        service_name=service_name,
        declared="otlp",
        endpoint_env="OTEL_EXPORTER_OTLP_ENDPOINT",
    )
```

## The one line the generator cannot write

`app/main.py` is developer-owned. The generator scaffolds it once and never touches it again --
that is the ownership boundary -- so a call the application must make at startup is a call the
application must make. Both py examples in this repository do, in one line:

```python
from app.generated.observability import tracing_export_status

tracing_export_status("support-copilot")
```

Regeneration does not remove it and does not need to repeat it. Then install the extra, which is
separate because not every deployment exports:

```console
pip install "aid-runtime-python[otlp]"
```

Call it and the spans go to the collector `OTEL_EXPORTER_OTLP_ENDPOINT` names, over OTLP/HTTP, from
a batched processor tagged with `service.name`. Do not call it and nothing is installed and nothing
changes -- which is the same behaviour every document before 0.27 had.

## Why it is opt-in twice over

The runtime could have installed an exporter on import. `import aid_runtime` would then set a global
tracer provider, and every application embedding AID would export wherever AID decided. It cannot be
undone: `set_tracer_provider` is one-way, so a host that wanted its own provider would have to use a
process AID never loaded.

So the first opt-in is the call. The second is the generator's: it emits the call *shape* and leaves
the call to you, because the file that would make it belongs to you. Both are refusals to decide
something on your behalf, and both cost exactly one line.

What is *not* deferred is the failure mode. `configure_export` never raises. An unset endpoint, a
missing SDK, an endpoint the SDK rejects -- each comes back as an `ExportStatus` with a frozen reason
and a `detail` that names the fix, and the application serves anyway. Telemetry that cannot start
must not stop a service from serving, and a startup crash over a metrics backend is the classic way
that goes wrong.

## What this is not

There is no exporter for `ts-vercel`. Writing one means picking a Node OpenTelemetry SDK major and a
shutdown hook that fits a serverless lifetime, and neither is a choice to guess at in a generator;
the refusal is the honest answer until then.

There is no generated OpenTelemetry Collector. The spec names the environment variable that holds
the address, and running the collector that answers it is yours -- for the same reason
`alert_channel_ids` defaults to empty rather than to an invented account id.

There is no new cost or latency *metric*. The exporter moves the spans that already existed; it does
not add a signal. `aid report` still aggregates from files, and `agent.cost` still arrives as a
derived series rather than a produced one, exactly as before.
