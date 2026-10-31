# Serving

A generated tree is a library of routes plus a hand-written entry point. This page is how you
run it, what the HTTP contract is, and where the seam for tests and fake providers sits.

## Python: you own `main.py`

`aid gen` never writes `app/main.py`. The generator owns the routers; you decide what an
application mounts and how it runs. The smallest correct version is nine lines:

```python
"""The ASGI entry point for the app."""

from __future__ import annotations

from fastapi import FastAPI

from app.generated.agents import agent_router
from app.generated.routes.answer_ticket import answer_ticket_router

app = FastAPI(title="support-copilot", version="0.1.0")

app.include_router(answer_ticket_router)
app.include_router(agent_router)
```

`agent_router` exists only when the spec declares an agent; a pipeline-only app imports just its
route module. Every import path here is generated, so adding a pipeline means adding one import
and one `include_router` line. That is deliberate: the generator cannot know your mounting
order or your app-level middleware.

Run it with any ASGI server:

```bash
python -m venv .venv
. .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e runtimes/python fastapi uvicorn
export OPENAI_API_KEY=...     # the env var each model's apiKeyEnv names
uvicorn app.main:app --port 8000
```

`app/app.spec.yaml` declares which env vars a deployment needs in `deployments.<name>.secrets`.
Nothing reads a `.env` file for you, and a secret declared in a store is refused at build time
by `ir/security-store-secret`.

## The HTTP contract

The request model comes from `requests.py`, derived from the pipeline's HTTP trigger. The
response model comes from the pipeline's final `emit`: `emit: { event: Reply }` produces
`response_model=Reply` and a return value built from the bound reply. Nothing about that
mapping is hand-written, which is why a type error in the spec becomes a build error instead
of a 500.

Two status codes carry meaning, and the generated route documents both:

- **400** - a guardrail stopped a step. Nothing downstream failed; the request was refused.
  `guardrail_block(exc)` recognises the runtime's blocked error and turns it into a 400 with
  the message from `onFail.message`.
- **502** - a downstream model or tool failed (`PipelineError`). The request was well formed,
  so this is not a 4xx.

A 502 with `provider: fake` and `output.kind: structured` is the expected result rather than a
bug: the fake provider is a seeded simulation that replies in prose, so the structured-output
retry loop exhausts its attempts. Use a real provider or inject a scripted fake.

## Streaming

A deployment with `streaming: true` changes the emitted route. It gains an `Accept` check:

```python
if wants_event_stream(request):
    _alias, _request = await _stream_request(deps, event)
    return StreamingResponse(deps.gateway.stream(_alias, _request), media_type=EVENT_STREAM)
```

A client that sends `Accept: text/event-stream` gets SSE frames as the model produces them; any
other client gets the ordinary JSON response from the same route. Both paths run the input
guardrail first, so a blocked request is a 400 over SSE too.

The trade-off is real, and it is a hard refusal rather than a warning: an `output`-stage guardrail
on a streaming deployment is rejected by the generator's plan check with
`unsupported-streaming`.

```console
$ aid gen
<spec>: error: 'api' streams, but 'reply_pii' inspects the 'output' stage. A guardrail cannot
see a reply that has already been sent, and buffering the stream to check it first would not
be a stream [unsupported-streaming]
    at deployments.api.streaming
```

Note where that error comes from: `aid validate` returns **ok** for the same spec, because the
rule lives in the target's plan compiler rather than in an `ir/*` gate. So you choose streaming
or output inspection, not both - and you find out at `gen`.

## The dependency seam

Every generated step reads its collaborators from one container. On Python it is a frozen
dataclass:

```python
@dataclass(frozen=True, slots=True)
class Deps:
    gateway: ModelGateway
    prompts: PromptRegistry
    tools: ToolExecutor
```

The fields are spec-dependent. The tutorial app has exactly those three; `support-copilot` adds
`limiter: ConcurrencyLimiter` and `agent_tools: tuple[Tool, ...]`, because it declares a
concurrency cap and an agent.

`build_deps()` defaults every seam to the generated wiring, and `get_deps()` memoises one
instance per process. That is the whole seam, and a test replaces it in one line:

```python
from fastapi.testclient import TestClient

from app.generated.deps import build_deps, get_deps
from app.main import app


def test_the_route_answers_with_a_reply(fake_gateway):
    app.dependency_overrides[get_deps] = lambda: build_deps(gateway=fake_gateway)
    try:
        response = TestClient(app).post("/hello", json={"name": "Ada"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
```

This is exactly how `examples/support-copilot/tests/` runs offline: a scripted fake provider is
injected at this seam, not declared as the primary model. `dependency_overrides.clear()` matters:
the override is process-global.

On TypeScript the same seam is a module-level singleton with an explicit setter:

```ts
export function buildDeps(options: BuildDepsOptions = {}): Deps;
export function getDeps(): Deps;
export function setDeps(deps: Deps | undefined): void;
```

`setDeps(undefined)` clears it so the next `getDeps()` rebuilds from the environment. The
source comment is explicit that this is the host-or-test seam and that nothing in production
calls it.

## Deploying

A `deployments` entry with `target: container` is what a release builds. The pieces that matter:

- **One process, one limiter.** `concurrency: 4` becomes `CONCURRENCY_LIMIT`, and every
  `parallel`/`map`/`reduce` fan-out draws from that one cap. Scaling out means more processes,
  each with its own cap.
- **Secrets come from the environment.** `secrets` is the list the deployment requires; the
  model's `apiKeyEnv` is the name it actually reads. Keep them in agreement.
- **The generated tree is reproducible.** Running `aid gen` in CI before a build is a cheap
  assertion that the committed `app/generated/**` matches the spec. See
  [The generated tree](generated-tree.md).

Read next: [Concepts](concepts.md) if you want the layer diagram behind these seams, or
[Support copilot](../walkthroughs/support-copilot.md) to see all of it in one real spec.
