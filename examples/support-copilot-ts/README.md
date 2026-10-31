# `support-copilot-ts` — the TypeScript target example

The same spec as [`support-copilot`](../support-copilot/), aimed at the `ts-vercel` target instead of
`py-fastapi`, so that the two examples differ by *target* and not by *domain*. It exercises everything that
target emits: a model gateway with a pinned model and a fallback, a prompt the registry serves, a business tool
behind a generated adapter, a retriever over a two-document corpus with a deterministic fake embedder and a
lexical reranker, a structured output, an HTTP route handler, and two evals — one gating on a statistical
threshold, one sampling ranked, cited retrieval results. Everything here comes from
[`app/app.spec.yaml`](app/app.spec.yaml) and the generator in
[`packages/generators/ts-vercel`](../../packages/generators/ts-vercel/).

The committed tree **is** that generator's golden fixture, so `pnpm test` fails if the two ever drift apart.

## Layout

| Path | Who owns it |
| --- | --- |
| `app/app.spec.yaml` | hand-written — the source of truth |
| `app/generated/**` | the generator; rewritten on every regeneration |
| `app/business/**` | seeded once by the generator, then yours; regeneration never touches it |
| `app/aid.manifest.json` | the generator; the hashes that make drift detectable |
| `app/api/tickets/answer/route.ts` | hand-written; the Next App Router shim that mounts the generated handler |
| `tests/server.ts` | hand-written; the Node host the end-to-end job boots |
| `tests/fake_gateway.ts` | hand-written; the deterministic gateway the tests and the host share |
| `tests/app.test.ts`, `package.json`, `tsconfig.json` | hand-written |
| `scripts/run-tests.mjs` | hand-written; runs the suite and pins the number of passing tests |
| `app/docs/**`, `app/evals/*.json` | hand-written; the retriever's corpus and the two eval datasets |

`app/api/tickets/answer/route.ts` is three lines of wiring: Next serves that file, and it delegates to
`app/generated/routes/answer_ticket.ts`, which is where the real handler lives. The generator cannot write the
shim itself — a plan may only write into `app/generated/**` and `app/business/**` — so the framework's mount point
is yours and the handler is generated. [`packages/generators/ts-vercel/README.md`](../../packages/generators/ts-vercel/README.md)
explains that split, and why Next is a deployment target rather than a dependency here.

## Regenerate

From the repository root:

```console
pnpm install && pnpm build
```

Then, from this directory:

```console
node ../../packages/cli/dist/cli.js gen --target ts-vercel
```

That reruns the spec checks, lowers the spec to the IR, runs the IR gates, and applies the plan through the
generator SDK's regeneration algorithm. It rewrites `app/generated/**` and `app/aid.manifest.json`, leaves
`app/business/**` alone, and refuses to overwrite a generated file that a human edited since the manifest was
written (it reports the drift and writes the new content as `.aid-rej` instead). Because the example is the
golden fixture, regenerate it in the same commit as any change to the generator.

`--target ts-vercel` is explicit on purpose: `py-fastapi` is the CLI's default, so the flag is what makes this
tree reproducible from a scratch checkout.

## Run it

```console
pnpm install
pnpm --filter support-copilot-ts-example build
AID_EXAMPLE_BROKEN_TOOL=0 node dist/tests/server.js
```

The host prints the port it bound, then answers the same request the tests send:

```console
curl -sS -X POST localhost:<port>/tickets/answer -H 'content-type: application/json' \
  -d '{"subject": "Acme: I was charged twice this month", "body": "Please refund the duplicate charge."}'
```

```json
{"category": "billing", "confidence": 0.93, "summary": "The customer was charged twice for one period."}
```

No API key and no network are needed. `fast` is the real model, but the spec declares `offline` — the runtime's
deterministic fake provider — as its fallback, and both the tests and the host wire the fake provider in through
the generated `setDeps` seam ([`tests/fake_gateway.ts`](tests/fake_gateway.ts)), so the route, the prompt, the
tool and the retrieval path all run offline and reproducibly.

In production the same handler is mounted by Next: `app/api/tickets/answer/route.ts` re-exports it, and the
`aid.manifest.json` beside the spec records which bytes the generator owns.

## Tests

```console
pnpm --filter support-copilot-ts-example test
```

Seven `node:test` cases: the gateway pins its alias and its offline fallback, the business tool resolves a known
account and falls back to an unknown one, the pipeline answers a ticket end to end, a failing tool surfaces as a
502 naming the tool, a body that does not match the request schema is rejected, and the Next route shim serves the
same handler the generator emitted. The suite sits outside the root `vitest` config, which collects
`packages/**/test/**/*.ts` and never reaches `examples/`, so it is collected by nothing there: CI's single `e2e`
job is its only caller, as `pnpm --filter support-copilot-ts-example test`. `scripts/run-tests.mjs` asserts that
exactly seven tests pass, so the step cannot go green by running none of them, and `tsconfig.tests.json` includes
`examples/*/tests/**/*.ts` so `pnpm typecheck` covers these files too.

## End to end

```console
pnpm e2e:ts
```

Regenerates this tree in place and requires it to be byte-identical, generates from the spec alone into an empty
directory and requires the committed `app/generated/**` to match byte for byte, then compiles the regenerated copy
with this directory's `tsconfig.json`, boots it and POSTs `/tickets/answer` over a real socket. The Python example
makes the same three claims through `pnpm e2e`; both run in CI's single `e2e` job.

## Deviations from the plan

Two, both recorded in the generator's README rather than hidden here:

- The `app/api/<path>/route.ts` shim is hand-written, because the plan validator confines writes to the managed
  tiers and the manifest's owner cross-check would reject the shim's path on the next run.
- Retrieval's vector store is `memory` in this example even though the target supports `pgvector`, because a
  required gate must never touch a database. The `pgvector` adapter is exercised by the runtime's own tests.
