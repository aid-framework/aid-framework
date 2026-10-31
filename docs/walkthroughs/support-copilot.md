# Walkthrough: support-copilot

`examples/support-copilot` is the largest example, and it is built to demonstrate disagreement
between enforcement points. It classifies an inbound support ticket and answers it with a structured
reply, over a nine-step pipeline, four guardrails that each run somewhere different, and two agents -
one of which can pause and needs a resume route.

It is 58 files on disk, 40 of them managed by the generator. See
[the generated tree](../guide/generated-tree.md) for the ownership split.

## Run it

```bash
cd examples/support-copilot
pip install -e .
uvicorn app.main:app --reload
pytest
```

`fast` declares `fallbacks: [offline]` and `offline` is `provider: fake`, so the pipeline runs end to
end with no network and no key. The eval gate samples against the fake too. The `triage` model is the
exception and the reason is instructive - see [Why `triage` has no fallback](#why-triage-has-no-fallback).

## The pipeline

`POST /tickets/answer` runs `answer_ticket`:

| # | Step | Why it is there |
| --- | --- | --- |
| 1 | `guard` `ticket_intake` at `input` | Before any model call. `tests/test_app.py` pins it by asserting the provider was never called. |
| 2 | `tool` `lookup_customer` | Binds `customer` for the parallel arms. |
| 3 | `retrieve` `handbook` | Binds `handbook`. |
| 4 | `parallel` - `generate` `customer_note`, `generate` `handbook_note` | Two independent readings, side by side. The arm count is capped by `deployments.api.concurrency`. |
| 5 | `agent` `triage_agent` | Answers once, holds nothing. Its answer becomes the rerank query, so a wrong guess costs relevance, never correctness. |
| 6 | `rerank` `lexical`, `topN: 1` | Precision after recall: one passage reaches the classifier, and the test counts them. |
| 7 | `guard` `handbook_pii` at `retrieval` | Inspects what is about to be spliced into the prompt, not the query that found it. |
| 8 | `generate` `classify_ticket`, `context: ranked` | The only model call whose output is the answer. |
| 9 | `emit` `Answer` | The pipeline's return value. |

Two steps look redundant and are not:

- **The input guard is first on purpose.** The generated code also checks every input-stage guardrail
  inline at each `generate` step - five call sites in this app, because the streaming path duplicates
  the last one. By the time the classifier is reached the ticket has already paid for a tool, a
  retrieve, an agent and two parallel generations. The `guard` step buys the refusal before any of
  that.
- **The retrieval guard is a second pass, not the only one.** `build_retriever` hands the generated
  retriever the `retrieval` table, so passages were inspected on the way out of `retrieve`. This step
  re-checks the narrower *reranked* subset - the one passage the classifier is about to be told is
  the handbook. `tests/test_app.py` pins both halves separately, stubbing the retriever's own check
  out for the step test, because a step that only looked load-bearing would be a different claim.

## The four guardrails

| Guardrail | Stage | Action | Policy | Reaches |
| --- | --- | --- | --- | --- |
| `ticket_intake` | `input` | `block` | `prompt-injection` | Every generate step, plus `triage_agent` (named) |
| `ticket_pii` | `input` | `redact` | `pii-detect` | Every generate step - and **no agent** |
| `refund_args` | `tool-call` | `escalate` | `secret-scan` | `refund_agent` only, because it names it |
| `handbook_pii` | `retrieval` | `block` | `pii-detect` | Every retriever, plus the explicit step |

The asymmetry is the lesson. A guardrail reaches the **generate path** by being declared: the
document's stage tables apply whether or not a step names them. A guardrail reaches an **agent** only
if that agent lists it. So `ticket_pii` is enforced on every generate and on no agent, and
`refund_args` is enforced on one agent and no generate - because it declares no `input` stage, and
the input table could never carry an `escalate`.

`ticket_intake` is listed by `triage_agent` rather than inherited, so the agent route gets the same
injection check without a second declaration.

## The agent routes

`main.py` mounts two routers, and the second one is the reason an agent is not just a step:

| Route | Purpose |
| --- | --- |
| `POST /agents/{agent_id}/run` | Runs a named agent. `AGENT_IDS` is `("refund_agent", "triage_agent")`; an unknown id is a **404**. |
| `POST /agents/resume` | Takes back the checkpoint a paused run returned. |

`refund_agent` declares `humanInTheLoop: {when: "true", channel: refunds}`, so every run asks before
it issues a refund. That pause is what the resume route exists for. `triage_agent` has no approval
to ask for, so a step can run it; a step hands back no checkpoint, and the generator refuses to open
a second pause path beside it.

## Why `triage` has no fallback

`fast` chains to `offline`. `triage` cannot, and the spec says why: the agent loop builds a
document for *every* model and refuses one without a `costProfile`, because "a budget cannot be
enforced against an unpriced model". `fast` is priced; the fake `offline` is not. So the agent's
model is priced and carries no fallback.

That refusal is enforced at `gen`, not at `validate`. Point `triage` at an uncatalogued `modelId`
without a `costProfile` and the gate registry still says the spec is fine - `aid validate` returns
`ok (0 errors, 0 warnings)` - while `aid gen` prints two errors, the second of which is the rule:

```console
$ aid gen app/app.spec.yaml --target py-fastapi
<spec>: error: ModelSpec carries a cost profile, and without one the ledger would report every call
on a billed model as free; ... [missing-cost]
    at models.triage.costProfile
<spec>: error: model 'triage' resolves no cost profile from the pinned catalog, and the agent loop
refuses an unpriced model because no budget can be enforced against one; ... [unsupported-agent]
    at models.triage.costProfile
```

So the generator refuses rather than silently dropping the chain. See
[Troubleshooting](../troubleshooting.md) for why some rules surface only at `gen`.

## The evals

`classify_quality` and `handbook_quality` both target `pipeline:answer_ticket` with `gate.ci: true`.
See [eval metrics](../reference/eval-metrics.md) for what each metric kind measures and how the
statistical gate decides.

## The streaming trade-off

`deployments.api` sets `streaming: true`, and that single line removes a capability from the whole
document: **no guardrail here declares `output`**, because the generator refuses an output-stage
guardrail on a streaming deployment. A streamed reply is already gone by the time anything could
inspect it, and buffering it first would not be a stream.

The output stage's one-enforcement case is therefore exercised by
[guarded-reply](guarded-reply.md) instead - and that example shows exactly what this one cannot.
