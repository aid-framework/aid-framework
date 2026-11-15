# RFC 0010 — Round 10: what a shipped row is allowed to claim

| Field | Value |
| --- | --- |
| Status | **Implemented.** Phase 0 landed in one PR. No spec language changed. |
| Phase | 0 of the delivery plan; Track B and Track A follow (see §8) |
| Affects | `site/scripts/features-data.mjs`, `site/scripts/features-page.test.mjs`, `site/scripts/gen-reference.mjs`, `docs/features.md`, `docs/index.md`, `docs/reference/spec.md`, one schema description |
| Continues | [RFC 0009](./0009-round-9-generated-app-smoke.md), which made local checks faithful to CI |
| Verified against | `origin/main` at `d4dc86f`, release `0.1.183` |
| Runtime used | `.venv\Scripts\python.exe` — CPython 3.12 |

> **What a reviewer must decide.** One question, and it is a question about honesty rather than
> architecture: *may a row that says "nothing is generated" be counted as a shipped, generated
> feature?* This round answers no, and makes the answer mechanical. It then applies the answer
> to the one row that currently fails it, and to two sentences that made the same claim in prose.
>
> Nothing here adds a capability. The deliverable is a gate: a shipped row now has to name a file
> that exists and mentions the symbol the row cites, and it has to say which of four kinds of
> existence it has. The value is entirely in the refusals that follow.

## 1. What was actually wrong

`docs/features.md` opens with 45 rows under "Out of the box", and the homepage band repeats their
counts per family. The page is generated from `site/scripts/features-data.mjs`, so the facts on it
cannot drift *from the registry*. What no test checked was whether the registry described the tree.

`features-page.test.mjs` was already a strong guard. It asserted, per row:

- the page renders a level-3 heading for it,
- `since` is not newer than the shipped release,
- `declaredBy` resolves to a schema property or a documented CLI command,
- `href` points at a heading that exists,
- a `DECLARED_FEATURES` row sits below the "Declared and gated, not generated" heading and above
  "Refused, on purpose".

Every one of those is a statement about the *document*. A row could pass all five while describing
code that no generator writes, because "this feature shipped" had no operational meaning beyond
"this object is in a JavaScript array".

### 1.1 The row that failed on its own wording

`feedback-signals` was the last entry in `SHIPPED_FEATURES`, so it was counted under "Out of the
box" and on the homepage. Its own `detail` ended:

> AID routes and stores nothing; the declaration and its refusal are what exist.

The CLI's own template (`packages/cli/src/templates.ts:479-483`) says the same thing more bluntly:
*"Feedback declared, not routed. … AID generates no feedback endpoint yet."* The row was not wrong
about the framework. It was in the wrong array, and the array was the claim.

This is exactly the reverse of the discipline `DECLARED_FEATURES` already documented for itself —
*promote a row here in the release that starts emitting it* — applied in the direction nobody had
written down, because it had never come up.

### 1.2 Two sentences making the same claim

The same audit found the claim twice more, in prose the registry never saw:

1. **The page's own introduction.** `## Out of the box` opened with *"Each section is behaviour the
   generator writes for you"*. Eleven of the 45 rows are commands, two are runtime behaviour and
   nine are build-time refusals. The sentence was false for 22 of them.
2. **The schema description of `observability.feedback.signals`.** It read *"One entry per endpoint
   the generator emits"*. No generator emits a feedback endpoint. That sentence is rendered verbatim
   into `docs/reference/spec.md`, which is the page a spec author trusts most.

Both are now corrected (§5, §6). The pattern is the finding: a claim about maturity is easy to
write, cheap to copy, and nothing in the build reads it.

## 2. The change

### 2.1 A vocabulary of four, not a boolean

`maturity` could have been `generated: true | false`, but that would have forced a lie in the
other direction: `aid fleet` is real, tested and vital, and it is not generated code. Labelling it
"generated" to keep the boolean simple would have replaced one dishonest word with another.

Each value names what a reader would actually go looking for:

| `maturity` | What exists | Rows |
| --- | --- | --- |
| `emitted` | a generator writes files into your tree | 23 |
| `enforced` | a build-time refusal; nothing is emitted beside it | 9 |
| `runtime` | the Python runtime implements it on the request path | 2 |
| `tooling` | a command does the work when you run it; no generated file changes | 11 |

`runtime` exists because two rows would otherwise be mislabelled twice over: `semantic-cache` is
implemented in `runtimes/python/src/aid_runtime/gateway.py`, and `eval-unreviewed` is enforced by the
runtime `Dataset` layer rather than by generated code — deliberately, so that a hand-edited module
keeps the refusal.

### 2.2 Evidence is a file *and* a symbol

A path alone is not evidence: `packages/generators/py-fastapi/src/emit/gateway.ts` exists whether or
not it emits a cost profile. So each row carries a marker, and the marker must appear in the file.

Where a constant exists, the constant is the marker (`AGENTS_PATH`, `GUARDRAILS_PATH`,
`DOCKERFILE_PATH`, `GATEWAY_MODELS_PATH`): it is stable, load-bearing, and cannot survive the
emitter being deleted. Where the feature is a gate, the marker is the diagnostic code constant
(`IR_DIAGNOSTIC_CODES.capabilityMissing`) or the string the refusal prints (`profile enterprise has
no measurement`). Where it is a command, it is the command name.

The full registry of 45 rows is in `site/scripts/features-data.mjs`. It is not repeated here; the
point of the exercise was to stop maintaining the same facts in two places.

### 2.3 No two rows may cite the same pair

A blanket `{ path: 'packages/generators/py-fastapi/src/emit/gateway.ts', marker: 'import' }` would
satisfy the first two rules 45 times and prove nothing. The test refuses a duplicate `path#marker`,
so each row has to name the *distinct* thing that makes it true.

This is the rule that makes the audit reproducible: adding a row forces a contributor to find the
line that emits it, which is the step that was missing.

## 3. The diagnostics

New tests in `site/scripts/features-page.test.mjs`, each with the message a contributor will see:

| Refuses | Message |
| --- | --- |
| a row with no maturity | `"<id>" has no maturity; say whether it is emitted, enforced, runtime or tooling` |
| a cited file that is gone | `"<id>" cites <path>, which is not in the tree` |
| a cited symbol the file never mentions | `"<id>" cites <marker> in <path>, which does not mention it` |
| two rows on one piece of evidence | `"<id>" and "<other>" cite the same <path>#<marker>, so one row is describing the other's code` |
| `emitted` on something no generator writes from | `"<id>" is labelled emitted, but <path> is not a generator's to write from` |
| `runtime` outside `runtimes/` | `"<id>" is labelled runtime, but <path> is not the runtime` |
| `tooling` outside `packages/cli/` | `"<id>" is labelled tooling, but <path> is not a command` |
| a declared-only row claiming an emitter | `"<id>" is declared-only; it cannot also claim a maturity or a generator` |

Both interesting cases were falsified before the change was accepted. Replacing `security-gate`'s
marker with `NotARealSymbol` produced the third message above; relabelling `fleet-summary` as
`emitted` produced the fifth. A gate that has never been seen to fail is a comment.

## 4. Why the emitting roots are a whitelist

`emitted` is checked against three roots: `packages/generators/`, `packages/generator-sdk/` and
`packages/cli/src/infra/`. The third is the awkward one and is deliberate: `observability.alerts`
becomes real OpenTofu and CDK in `packages/cli/src/infra/modules/alerts.ts`, which is a generator by
behaviour and a CLI package by location. Labelling it `tooling` would understate what it does;
labelling it `emitted` and widening the root is the honest trade, and the whitelist is what stops
the widening from becoming a loophole.

## 5. The reclassification, and what the page says now

`feedback-signals` moved from `SHIPPED_FEATURES` to `DECLARED_FEATURES`, reshaped to the declared
schema (`declares`, `enforces: ir/feedback-pii`, `missing`). Consequences, all of which the tests
enforce:

- the homepage band's *Quality gates* count fell 11 → 10, with no other edit;
- the page renders the row below "Declared and gated, not generated" with a `**Not yet generated:**`
  bullet, and the prose now states the one place the declaration has an effect — `aid trace
  export` withholds `observability.feedback.pii.redact` alongside `observability.redact`.

The `## Out of the box` introduction now describes the four maturities instead of claiming every row
is generated, and each row carries a `**What exists:**` bullet naming the file behind the claim.

`DECLARED_FEATURES`' docstring now documents the move in both directions, including that correcting
an inventory claim is not a framework change and needs no version bump. That matters: the next
person to find a mislabelled row should not have to invent the precedent.

## 6. The schema sentence

`observability.feedback.signals` now reads:

> The signals this app accepts, by name, so a reviewer reads the data surface rather than discovering
> it in code. No endpoint is generated for a signal yet: the entry is what the feedback gate checks,
> and the route that collects it is the application's to write.

No schema structure changed — a description string only. `specVersion` is unchanged and no document
that parsed before fails now. `docs/reference/spec.md` is regenerated from it.

## 7. Backward compatibility

| Surface | Effect |
| --- | --- |
| Spec language | **Unchanged.** No key added, removed or reinterpreted. No `specVersion` bump. |
| `aid validate` / gates | **Unchanged.** No diagnostic added or reworded. |
| Generated tree | **Unchanged.** Nothing in `app/generated/` differs; `gen --check` is unaffected. |
| `aid eject` | **Unaffected.** No new artefact, so no new ownership question. |
| `docs/features.md` | One row moved section; 45 rows gained a bullet; the intro changed. |
| Homepage band | One count fell by one. Regenerated, not hand-edited. |

The version bump is a patch: `site/**` is a releasable path, and the release workflow decides.

## 8. What comes next

This phase exists because the plan's later phases all rest on counting what ships. The ordering
below is the delivery plan this round is the first increment of.

| Phase | Smallest shippable increment | Why here |
| --- | --- | --- |
| **B. Delivery method** | `docs/guide/delivery-method.md` + `aid review <dir>`: one readiness pack per customer (profile coverage, pins, gate results, unresolved declared-only constructs) | A consultancy sells a method before it sells a feature. Costs no spec change. |
| **A1. Durable run state** | Actually persist a paused run: generated checkpoint table, `POST /agents/resume` reading from it | The largest honest gap in `DECLARED_FEATURES`. A client whose agent dies mid-run does not care which cloud it cannot survive on. |
| **A2. Cost at runtime** | Meter spend per run against `maxCostBudget`, refuse the next step when exhausted | Second question every client asks; today cost is priced at build time only. |
| **A3. Identity verification** | Verify a token against the declared `identity.issuer` instead of naming who does | Moves `ir/identity-verified-by` from declared to enforced with code. |
| **A4. Azure / Kubernetes** | One target through the capability matrix, with refusals for unsupported pairs | Only after A1–A3: portability of a service that cannot survive a restart is a demo. |
| **A5. Bedrock streaming** | The refusal in `CLOUD_REFUSALS` replaced by an emitter | Small, visible, closes a named gap. |
| **A6. Composed pipelines** | `pipelines[].steps` referencing agents, with step budgets | Last: it multiplies every earlier decision. |

Each phase follows the rule this one was built to enforce: **a row moves from `DECLARED_FEATURES`
to `SHIPPED_FEATURES` in the release that starts emitting it, and not before.** A1's entry is
already written down as declared; it becomes shipped only when a paused run outlives a process.

## 9. What this round does not prove

- **That a marker is the *right* marker.** The test proves the cited symbol is in the cited file.
  It cannot prove the symbol is what makes the feature true. That reviewer judgement is why the
  markers are constants and diagnostic strings rather than import statements.
- **That the counts on the band are meaningful to a buyer.** 23 emitted is a defensible number for
  "what a generator writes"; it is not a measure of value.
- **That no other prose overclaims.** This audit found three claims by reading. Nothing scans prose
  for the phrase "the generator writes". A follow-up could extend `scripts/docs-claims.mjs` in that
  direction; it is not done here.
