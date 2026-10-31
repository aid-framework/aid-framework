# `support-copilot` — the Python end-to-end example

The smallest spec that still exercises every contract the `py-fastapi` target emits: a model gateway with a
pinned model and a fallback, a prompt the registry serves, a business tool behind a generated adapter, a
structured output, an HTTP route, and an eval that gates on a statistical threshold. Everything here comes from
[`app/app.spec.yaml`](app/app.spec.yaml) and the generator in
[`packages/generators/py-fastapi`](../../packages/generators/py-fastapi/).

The committed tree **is** that generator's golden fixture, so `pnpm test` fails if the two ever drift apart.

## Layout

| Path | Who owns it |
| --- | --- |
| `app/app.spec.yaml` | hand-written — the source of truth |
| `app/generated/**` | the generator; rewritten on every regeneration |
| `app/business/**` | seeded once by the generator, then yours; regeneration never touches it |
| `app/aid.manifest.json` | the generator; the hashes that make drift detectable |
| `app/main.py`, `app/__init__.py` | hand-written; mounts the generated routers |
| `app/evals/*.json` | hand-written; the eval dataset and its recorded baseline |
| `tests/**`, `pyproject.toml` | hand-written |

## Regenerate

From the repository root ([`docs/design.md` §10](../../docs/design.md)):

```console
pnpm install && pnpm build && pnpm generate:example
```

That reruns the spec checks, lowers the spec to the IR, runs the IR gates, and applies the plan through the
generator SDK's regeneration algorithm — the same one the CLI will use. It rewrites `app/generated/**` and
`app/aid.manifest.json`, leaves `app/business/**` alone, and refuses to overwrite a generated file that a human
edited since the manifest was written (it reports the drift and writes the new content as `.aid-rej` instead).
Because the example is the golden fixture, regenerate it in the same commit as any change to the generator.

## Run it

```console
python -m venv .venv
.venv/bin/pip install -e ../../runtimes/python
.venv/bin/pip install -e ".[dev]"
.venv/bin/uvicorn app.main:app
```

```console
curl -sS -X POST localhost:8000/tickets/answer -H 'content-type: application/json' \
  -d '{"subject": "Charged twice", "body": "My card was billed twice for the same month."}'
```

No API key and no network are needed. `fast` is the real model, but the spec declares `offline` — the runtime's
deterministic fake provider — as its fallback, and the tests wire the fake provider in directly
([`tests/fake_gateway.py`](tests/fake_gateway.py)), so the route, the prompt and the tool run offline and
reproducibly, and the eval gate does too when it is driven through the same fake provider.

## The eval gate

```console
.venv/bin/python -m app.generated.evals.classify_quality
```

Prints the gate summary and exits non-zero on a regression. This is the production entry point, so it measures
the model the app is configured with: given `OPENAI_API_KEY` it samples `fast`, and without one it falls over to
the `offline` fallback — a bare fake provider, which has no way to know what a good answer looks like and
so scores zero rather than passing.

The stored baseline was recorded from the *expectation-carrying* fake provider
([`tests/fake_gateway.py`](tests/fake_gateway.py)) at accuracy 1.0, so the offline gate is the one the tests
drive:

```console
.venv/bin/pytest tests/test_eval_gate.py -v
```

It samples each case `samples: 5` times, scores the JSON-schema metric, and compares the mean with the baseline
recorded in [`app/evals/classify_quality.baseline.json`](app/evals/classify_quality.baseline.json), tolerating
`maxRegression: 0.05`. The same file runs the falsifying case too: at accuracy 0.25 the provider answers a case
wrongly, the mean drops, and the gate fails.

The comparison is **statistical, not equality**. A model that answers differently on two runs is behaving
normally, so the gate exists to catch a *drop* in quality, not a change in output; a run that merely differs
from the baseline passes. The generated module delegates every one of those statistics to
[`aid_runtime.evals`](../../runtimes/python/) — it holds only the metric list, the thresholds and the
dataset loader.

## Checks

```console
pytest
ruff check . && ruff format --check .
mypy
```

The example holds itself to the runtime's ruff selection and to `mypy --strict`, inside this directory only,
because CI's `python` job lints `runtimes/python` and never `examples/`.

## Out of scope

Retrieval, memory, guardrails, multi-step agent loops, streaming response bodies, latency and cost budgets, and
`llm-judge` metrics — all deferred ([`docs/design.md` §11](../../docs/design.md), [`§14`](../../docs/design.md)).
Control flow is plain async, so there is no orchestration dependency.
