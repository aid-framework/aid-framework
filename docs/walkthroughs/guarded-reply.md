# Walkthrough: guarded-reply

`examples/guarded-reply` is one pipeline, one guardrail and one claim: **a `guard` step is
load-bearing exactly where no route-level table sees the payload.** It is deliberately the smallest
example that can prove that, and the second example exists because the first could not.

It is 29 files on disk. The pipeline is four steps.

## Run it

```bash
cd examples/guarded-reply
pip install -e .
uvicorn app.main:app --reload
pytest
```

## The enforcement map

| Stage | Enforced by |
| --- | --- |
| `input` | The generated code at every `generate` step, inline, and the agent route for the guardrails it lists |
| `output` | The generated code at every `generate` step, inline - **refused entirely on a streaming deployment** |
| `retrieval` | Every generated retriever, per passage, during `retrieve` |
| `tool-call` | An agent loop only; refused for a pipeline step |

Read the `output` row carefully. It is enforced at a generate step by `OUTPUT_GUARDRAILS`, which is
emitted only when some guardrail declares `output`. **But nothing here produces text at a generate
step before the guard runs** - the text comes from an agent. And an agent route applies the
guardrails the agent *lists*, not the document's stage tables.

So the document-level `output` guardrail reaches nothing until a step names it. That is the whole
design of this example.

## The pipeline

`POST /reply` runs `answer_message`:

| # | Step | What it does |
| --- | --- | --- |
| 1 | `agent` `triage_agent` | Summarises the inbound message. This prose is the payload no table inspects. |
| 2 | `guard` `reply_pii` at `output` | **The only enforcement.** `reply_pii` declares `output` and nothing else. |
| 3 | `generate` `reply_to_message` | Reached only when step 2 allowed the note. |
| 4 | `emit` `Reply` | |

`triage_agent` lists `message_injection` and **not** `reply_pii`. That omission is deliberate: if the
agent listed `reply_pii`, the loop would apply it and the `guard` step would be redundant. The
security gate requires the input guardrail for an agent route that takes caller text, so
`message_injection` is named; the output guardrail is left to the step.

## The mutation test

The claim is falsifiable, and `tests/test_reply.py` falsifies it. Delete the emitted
`check_output` call and the agent's text flows on to the reply prompt: the test then sees
`reply_to_message` asked **with the contact details in `note`**, and the route answers `200`
instead of `400`. A step that only looked load-bearing would be a different claim; this one is
pinned by removing it.

## Why `support-copilot` could not make this claim

`examples/support-copilot` streams, and a streamed reply is already gone by the time anything could
inspect it. The generator refuses an output-stage guardrail on a streaming deployment rather than
buffer the stream and call it a stream.

That refusal is real and it is measured. Flipping `streaming: false` to `true` in this example:

```console
$ aid validate app/app.spec.yaml
app/app.spec.yaml: ok (0 errors, 1 warnings)
$ aid gen app/app.spec.yaml --target py-fastapi
<spec>: error: 'api' streams, but 'reply_pii' inspects the 'output' stage. A guardrail cannot see a
reply that has already been sent, and buffering the stream to check it first would not be a stream
[unsupported-streaming]
    at deployments.api.streaming
```

Two things about that output are worth keeping:

- **`validate` returns `ok`.** The rule lives in the target's plan compiler, so it is reported by
  `gen`, not by the gate registry. A spec that passes `validate` can still be refused by the target
  you asked for - see [Troubleshooting](../troubleshooting.md).
- **The error is attributed to the deployment**, `deployments.api.streaming`, which is the line that
  has to change.

Read next: [support-copilot](support-copilot.md) for the large example, or
[eval metrics](../reference/eval-metrics.md) for the gate.
