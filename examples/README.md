# `examples/`

Example specs and the apps generated from them — the fastest way to understand what AID Framework is for.
Build the CLI once from the repository root (`pnpm install && pnpm build`), then drive any example from its
own directory. The `support-copilot` trees are committed as their generator's golden fixture, so `pnpm test`
fails if the spec, the generated code, and `app/aid.manifest.json` drift apart.

## `support-copilot/` — Python, `py-fastapi`

The smallest end-to-end example, and the one the quickstart uses. Its spec exercises the `py-fastapi` target end to end:
a model gateway with a pinned model and an offline fallback, a prompt registry, a business tool
(`lookup_customer`), structured output, `POST /tickets/answer`, an in-memory retriever over a two-document
corpus with citations, input and retrieval guardrails, a `buffer` memory tier, agent routes including a
refund confirmation and resume, a streaming deployment, and two eval gates (JSON-schema and retrieval).

```bash
cd examples/support-copilot
node ../../packages/cli/dist/cli.js validate
node ../../packages/cli/dist/cli.js gen --dry-run
```

With a Python 3.11 virtual environment active, install the runtime and the example's dev dependencies and
run its tests:

```bash
uv pip install -e ../../runtimes/python -e ".[dev]"
pytest
```

Serving it, the eval gate, and the offline fake-provider wiring are documented in
[`support-copilot/README.md`](support-copilot/README.md).

## `guarded-reply/` — Python, `py-fastapi`

A smaller, single-purpose app that pins one claim: a `guard` step is load-bearing exactly where no
route-level table sees the payload. An agent's draft is checked at the `output` stage before it reaches the
reply prompt, so deleting the emitted `check_output` call makes `POST /reply` answer 200 instead of 400.
The deployment is non-streaming on purpose, because a streamed reply could not be inspected; two guardrails
are declared (`prompt-injection` on input, `pii-detect` on output).

```bash
cd examples/guarded-reply
node ../../packages/cli/dist/cli.js validate
node ../../packages/cli/dist/cli.js gen --dry-run
uv pip install -e ../../runtimes/python -e ".[dev]"
pytest
```

## `support-copilot-ts/` — TypeScript, `ts-vercel`

The same support-ticket domain as `support-copilot`, compiled by `ts-vercel`, so the two trees differ by
target and not by domain. It exercises retrieval over the same two-document corpus, reranking, a `buffer`
memory tier, an agent with a tool, input/output guardrails, and two routes: `POST /tickets/answer` and
`POST /tickets/triage`, the pipeline that carries every step kind this target emits. Three eval gates cover
the classifier, retrieval, and triage. The Next App Router shim is hand-written; the handler is generated.

```bash
cd examples/support-copilot-ts
node ../../packages/cli/dist/cli.js gen --target ts-vercel --dry-run
pnpm --filter support-copilot-ts-example test
```

[`support-copilot-ts/README.md`](support-copilot-ts/README.md) covers serving it and the end-to-end harness.
From the repository root, `pnpm e2e` and `pnpm e2e:ts` regenerate the two golden trees and boot the result
over a real socket.

## Contributing an example

Examples are meant to be read, copied, and modified. If you would like to contribute one, please open an
issue first so we can pick a domain that adds coverage rather than duplicating these.
