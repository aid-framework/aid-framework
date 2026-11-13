# RFC 0006 — Round 6: a refusal where the runtime cannot serve, and what the catalog is

| Field | Value |
| --- | --- |
| Status | **Accepted** — records decisions. §1 is built, tested and gated in this round; §2 and §3 are decisions with no code. |
| Phase | 6 (verify, then close the gap it found) |
| Affects | `packages/generators/py-fastapi` (plan gate), `packages/generators/ts-vercel` (plan gate), `site/scripts/features-data.mjs` and `site/scripts/gen-reference.mjs` (the published claims), `runtimes/python/src/aid_runtime/providers/bedrock.py` (docstring), `docs/features.md` (generated) |
| Continues | [RFC 0001](./0001-agents-at-scale.md), [RFC 0002](./0002-agents-at-scale-round-2.md), [RFC 0003](./0003-round-3-agent-evals.md), [RFC 0004](./0004-round-4-resume-and-agent-loop.md), [RFC 0005](./0005-round-5-site-and-hygiene.md) |
| Verified against | `origin/main` at `0b86cd5`, release `0.1.171`, spec `0.33` |

> The round opened on a report that AID denied Bedrock streaming. AID's *adapter* denies it and
> its *published pages* denied it, but the reason given for the denial was wrong, and nothing
> refused the spec. This RFC records what was true, what is now refused, and two scoping
> decisions that were being made by omission.

---

## 0. Summary

| # | Decision | State |
| --- | --- | --- |
| 1 | A deployment that streams from a model whose adapter returns the whole reply is refused when the app is generated, naming the model, the adapter and the fix | **Built** — `unsupported-streaming` (`py-fastapi`), `streaming-unsupported` (`ts-vercel`) |
| 2 | Bedrock's own streaming is not the limitation; the adapter is. The published pages now say so at the point where they used to imply otherwise | **Built** — a `**Why:**` line on the `bedrock` provider section, and a qualified AWS-module grant |
| 3 | Azure and Kubernetes stay refused by name for this roadmap and are not built | **Decided** — no code, no schema change |
| 4 | The model catalog is a curated offline price-and-limit table, not a mirror of the providers' model lists, and is documented as such rather than promised to grow | **Decided** — documentation only; refreshing its ids is deferred, §4 |

---

## 1. The stream the runtime cannot serve (built)

### 1.1 What the report caught

`site/scripts/support-data.mjs` derives every `### <provider>` capability line from
`ADAPTER_CAPABILITIES` in `packages/generators/py-fastapi/src/names.ts`, so the `bedrock`
section printed "Refuses: streaming (`BedrockProvider` does not advertise `STREAMING`)"
while the AWS-module section printed that the modules emit
`bedrock:InvokeModelWithResponseStream`. Both sentences were true and, together, they read as
a defect because neither said *whose* limit it was.

It was the adapter's. Bedrock's `ConverseStream` "works with all Amazon Bedrock models that
support messages" and "requires permission for the `bedrock:InvokeModelWithResponseStream`
action" — the exact grant the AWS module already writes. `BedrockProvider` has no `stream`
because `/converse-stream` replies in AWS's binary event-stream framing, not SSE;
`runtimes/python/src/aid_runtime/providers/bedrock.py` says so in its own docstring.

### 1.2 What was actually broken

The docstring claimed "the capability gate refuses a spec that asks for it instead of failing
mid-run." **No such gate existed for the pinned model.** Both generators refused only the
*route shape*: a deployment whose transport cannot stream. So a spec could declare
`deployments.<id>.streaming: true` on a pipeline whose `generate` step pins a Bedrock model,
and:

- `aid validate` returned `ok (0 errors, 0 warnings)`;
- `aid gen` exited 0 and emitted `StreamingResponse(deps.gateway.stream(...))`;
- the first request raised, because `ModelGateway.stream` calls `self.require(alias,
  (Capability.STREAMING,))` and has no fallback chain.

A gate that does not exist, described as existing, on a route that fails on first use, is the
worst of the three failure modes: it is the one an operator only discovers in production.

### 1.3 The refusal

`checkDeployments()` in `py-fastapi/src/validate.ts` and `checkStreaming()` in
`ts-vercel/src/validate.ts` now resolve the deployment's pipeline to its `generate` step, look
the model up by alias, resolve the provider's adapter, and refuse when the adapter does not
advertise streaming:

```text
'<deployment>' streams, but pipeline '<pipeline>' generates with model '<alias>' (<modelId>),
which provider '<provider>' serves through <Adapter>. That adapter does not advertise
'Capability.STREAMING' -- it returns the whole reply at once -- so the emitted route's call to
deps.gateway.stream() would raise CapabilityMismatchError on the first request. Pin a model
whose adapter streams, or drop `streaming` from the deployment.
```

Reporting `py-fastapi` as `unsupported-streaming` and `ts-vercel` as `streaming-unsupported`.

### 1.4 Why this is a generator gate, not an `ir/*` gate

`ir/deploy-streaming` already exists and stays: it refuses a deployment whose *transport*
cannot stream. The model half cannot live beside it, for two reasons.

1. **The IR does not know the adapter.** `providerAdapter()` maps an `ir` provider onto an
   adapter class, and that mapping is target-specific: `ADAPTER_CAPABILITIES` is a
   `py-fastapi` table and `ts-vercel` keeps its own. Two targets can serve different subsets.
   An IR gate would have to pick one, or publish a capability set AID does not promise.
2. **The IR does not know that the route will stream.** The refusal only makes sense when a
   deployment actually emits a streaming route, which is the plan's decision, not the IR's.

The consequence is visible and should not surprise anyone: **`aid validate` does not report
it; `aid gen` does.** `aid validate` runs the IR gates. The plan is per-target and runs at
generation time. `docs/features.md` attributes the diagnostic to generation, and the two
providers are listed as `unsupported-streaming` and `streaming-unsupported` under the
refusals section rather than under `ir/*`.

### 1.5 Tests

| Test | Proves |
| --- | --- |
| `py-fastapi/test/target-surface.test.ts` — "a stream the pinned model cannot produce is refused at plan time" | the diagnostic names model, adapter and call; `planPyFastApi` throws; the same model is accepted when no deployment streams |
| `py-fastapi/test/providers.test.ts` — "refuses a deployment that asks it to stream, rather than raising on the first request" | the Bedrock adapter's own conformance spec is refused, so the provider cannot regress silently |
| `ts-vercel/test/streaming.test.ts` — "a stream the pinned model cannot produce" | the same two properties on the second target |

Six pre-existing `providers.test.ts` conformance fixtures relied on the hole: they pinned a
Bedrock model and kept `streaming: true`. They now declare `streaming: false` and the model
keeps its `STREAMING` declaration, so the capability-versus-adapter comparison the tests were
written for is still exercised.

---

## 2. The published claims (built)

Three edits, all in one place each:

1. `gen-reference.mjs` grows an `ADAPTER_NOTES` table keyed `Adapter.MEMBER`. When a provider
   section lists a capability the adapter does not advertise, and a note exists, the page
   prints a `**Why:**` line after the refusal. The note for `BedrockProvider.STREAMING` says
   Bedrock does stream, names `ConverseStream`, names the binary event-stream framing as the
   adapter's reason, and cites the build-time diagnostic.
2. The note is keyed by the pair, not the provider, so **it disappears the moment the adapter
   starts advertising the capability**. An explanation that outlived its cause would be a
   second, quieter untruth.
3. The AWS module's `emits` string in `features-data.mjs` no longer implies the stream grant
   is reachable: it says the grant follows the service flag, so it is written for a Bedrock
   app too, and that no Bedrock-pinned route can use it yet.

`bedrock.py`'s docstring now names the two diagnostic codes and says plainly that the limit
is the adapter's, not the provider's.

---

## 3. Azure and Kubernetes (decided, not built)

Both are refused by name today: `ir/cloud-unsupported` names the deferral for `azure` and
`kubernetes`, and the schema admits the spelling so the refusal can explain itself instead of
a pattern mismatch doing it.

**Decision: this stays. Neither is built in this roadmap.** The reasons are the ones AID is
built on, not effort:

- Both need a *runtime* story AID would have to own — a Kubernetes deployment object model, or
  an Azure identity and networking model — and the refusal exists so that a spec cannot pin a
  cloud for which no module, workflow or credential path is generated. Refusing loudly is the
  feature.
- Neither can be approximated by renaming an existing module. A `kubernetes` deployment that
  emitted ECS task definitions would pass a gate and fail a customer.

Reopening requires an RFC that ships: the module(s), the credential path, the capability-matrix
row, the refusal text it replaces, and a byte-asserted fixture. Until then the matrix row stays
a refusal and the docs say so.

---

## 4. The catalog (decided: document the boundary, defer the refresh)

### 4.1 The question

"Why does the catalog contain fewer models than the provider serves?"

Because **it is not a model list.** `models[]` in a spec requires only `provider` and
`modelId` (`packages/spec/src/schema/spec.schema.json`); `limits` and `costProfile` are
optional and *defaulted* from the catalog. Pin `claude-sonnet-4-5-20250929` today and it
builds, generating an adapter call with the limits and price the spec declares, or none.

What the catalog is, in its own `$comment`: "Offline model catalog. Lookups are deterministic
and never touch the network … a null rate means the price has not been verified offline, and
the cost gate treats it as unknown rather than free."

So the count is the number of entries whose limits and price someone verified by hand against
a published rate card. That set is small because it is a maintenance liability, not because
the providers are limited. The expectation gap comes from reading it as coverage.

### 4.2 What that costs

Three costs, and only the third is invisible:

1. A model with no catalog entry has no default limits, so the spec must declare them.
2. A model with no price makes `ir/cost-profile-unknown` fire the moment an eval declares a
   budget — refusal, not a silent zero. That is the intended behaviour.
3. **Nothing in the table says an entry is stale.** The schema has entry
   `{provider, limits, costProfiles}` and no status field, so a retired id looks exactly like a
   current one. As of this round the table still offers `claude-3-5-sonnet-20241022` and
   `claude-3-5-haiku-20241022` as priced, and `azure-gpt-4o-mini` as an alternative price for
   `gpt-4o-mini` although `azure` is not in `SERVED_PROVIDERS` and no adapter is generated for
   it.

### 4.3 Decision, and what is deferred

**Document the boundary now; do not refresh the ids in this round.** Refreshing means
re-verifying every price against a live rate card, and a wrong number in this table is worse
than a missing entry, because a missing entry is refused while a wrong one silently
under-budgets a production service. Adding a `retired`/`supersededBy` field without a gate
that consumes it would be a comment, not a control.

Deferred, in order:

1. A gate for a *retired* entry: `ir/model-retired` with `supersededBy`, so a spec pinning a
   withdrawn id is refused with the replacement rather than failing at the provider.
2. A price-refresh pass over the ids that survive, recorded with the date each rate was read,
   which needs the schema field that item 1 introduces.
3. Publish the catalog as a generated reference page. `docs/reference/support.md` counts
   entries per provider ("3 models, 3 priced"); it does not list ids, which is why this
   discrepancy was only visible by reading the JSON.
4. Delete the dead `azure-gpt-4o-mini` profile, or keep it and say in the file that it prices
   the OpenAI-compatible deployment of the same model. Today it reads as an Azure capability.

---

## 5. Non-negotiables this round

- **No spec-language change.** The grammar already accepted a streaming deployment on a
  non-streaming model; the refusal is a new diagnostic about an accepted document, not a new
  spelling. No `specVersion` bump, and the registry count does not move.
- **No hosted control plane, no proxy.** The refusal is computed from the spec and the
  adapter table; nothing was added to a request path.
- **Reproducibility.** No generated artifact changed shape. `docs/features.md` is generated
  and `site/scripts/gen-reference.mjs --check` is clean.
- **Honesty.** The claim that was false (`the capability gate refuses a spec that asks for
  it`) is now true and is tested; the claim that implied Bedrock could not stream is now
  attributed to the adapter, on the page, with the grant's reachability stated.

---

## 6. Addendum: the adapter was the limitation, so the limitation was removed

This round shipped the honest half of a claim -- *Bedrock streams; our adapter does not* -- and
left the capability unserved. A later change removed the cause instead of the sentence, so two
rows above no longer describe what the repository does.

- **Row 1** said a deployment that streams from a model whose adapter returns the whole reply is
  refused when the app is generated, and named a code for each target. `ts-vercel` still does
  that: its provider seam answers every request with one buffered body, so a model whose adapter
  cannot frame a reply is refused as `streaming-unsupported`. `py-fastapi` no longer has the case
  at all. Its sixth adapter, `BedrockProvider`, now decodes the AWS `ConverseStream` binary
  event-stream framing -- verifying the prelude and message CRC32 of every frame, taking text from
  `contentBlockDelta`, the stop reason from `messageStop` and usage from `metadata` -- and
  advertises `Capability.STREAMING`. All six adapters decode a frame stream, so the model half of
  the plan-time gate became unreachable and was deleted rather than left as a refusal that could
  never fire. The `unsupported-streaming` code it reported is still live for the three cases that
  can still be refused on that target: a transport that cannot stream, a pipeline route the
  output guardrail cannot honour while streaming, and a pipeline shape the emitted route cannot
  build.
- **Row 2 and the `**Why:**` line it describes** are gone. `ADAPTER_NOTES` in
  `site/scripts/gen-reference.mjs` was keyed `Adapter.MEMBER` so a note would disappear the
  moment the adapter advertised the capability; the note is deleted and the registry is empty,
  because every capability the current adapters omit is one the provider does not serve.
  `docs/features.md` now lists streaming under `bedrock`'s **Advertises** and carries no
  **Refuses** line for it, and the AWS module bullet no longer says no Bedrock-pinned route can
  use the grant it writes.
- **The features registry entry** named `streaming-on-a-model-that-cannot` now points at
  `streaming-unsupported`, the code that can still fire, and its prose says which target refuses
  and why. It previously pointed at `unsupported-streaming`, which would have told a reader that
  `py-fastapi` refuses a document it now generates.
- **Runtime coverage.** `runtimes/python/tests/test_bedrock_provider.py` gained a frame builder and
  six tests over a real `ConverseStream` body: text deltas across frames, a stop reason, usage,
  a split frame reassembled across reads, a corrupted checksum refused, and an exception frame
  surfaced as a `ProviderResponseError`. The adapter's capability test now asserts `STREAMING` is
  advertised instead of asserting it is not.
- **No spec-language change**, so no `specVersion` bump and no registry count change. The
  generated artifacts of a streaming Bedrock deployment do change -- the observability report no
  longer records a shortfall for the model -- and the byte-asserted fixtures were restamped with
  the release that carried the change.
