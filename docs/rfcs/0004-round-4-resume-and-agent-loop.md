# RFC 0004 — Round 4: resume integrity and making the improvement loop real

| Field | Value |
| --- | --- |
| Status | **Draft — awaiting review.** No feature code written. |
| Phase | 0 (verify only) |
| Affects | `runtimes/python` (agent loop, checkpoint), `generators/py-fastapi` (`agents.ts`, `validate.ts`), `ir` gates (`delivery`, `security`, `observability`), `cli` (`trace export`), `site/scripts/features-data.mjs`, `docs/` |
| Continues | [RFC 0001](./0001-agents-at-scale.md), [RFC 0002](./0002-agents-at-scale-round-2.md), [RFC 0003](./0003-round-3-agent-evals.md) |
| Verified against | `origin/main` at `cebde51`, release `0.1.162`, both templates on spec `0.31` |

> **Nothing proposed here is built.** Every claim about current behaviour cites the file and
> line that proves it, or quotes the command that produced it. Items the round-4 brief
> asserted that this round could not reproduce are marked **UNCLEAR** and are not acted on.

---

## 0. Summary

| # | Check | Verdict |
| --- | --- | --- |
| 1 | `POST /agents/resume` accepts a tampered checkpoint | **PASS (defect confirmed)** — reproduced; see §1 |
| 2 | Repo claims generated identity and generated durable state | **FAIL (repo overstates)** — three published pages contradict the code; see §2 |
| 3 | Agent runs cannot flow trace → dataset → eval | **FAIL, and worse than described** — the enterprise export gate is satisfied by a declaration that redacts nothing agent-relevant; see §3 |
| 4 | Trajectory evals are scripted-model only | **PASS (claim accurate)** — replay exists, recording does not; see §4 |
| 5 | Homepage defects (a)–(d) | **PASS**, all four confirmed, plus two the brief did not list; see §5 |
| 6 | Azure/Kubernetes refused with no decision record | **PASS (defect confirmed)** — refusal is a schema enum, not a named diagnostic; see §6 |
| — | Not in the brief: an agent document with a sensitive field name is **unbuildable in every configuration** | **PASS (new, severe)** — five paths, five refusals, no build; see §7 |

The two findings that change the plan are §3 and §7. §3 means the honesty work is not
"export agent traces" but "the gate that is supposed to stop unredacted enterprise export
does not look at the thing it is protecting." §7 means an entire class of ordinary
enterprise agent specs cannot be compiled at all, and the three gates involved each blame a
different file.

---

## 1. Item 1 — the resume route is an unauthenticated bearer capability

### 1.1 What the generated route does

`packages/generators/py-fastapi/src/emit/agents.ts` emits `RESUME_ROUTE` (~330–350). The
whole of its validation is the checkpoint's Pydantic shape:

```python
try:
    checkpoint = AgentCheckpoint.model_validate(event.checkpoint)
except ValidationError as error:
    raise HTTPException(status_code=422, detail=...) from error
...
return await runtime.resume(checkpoint, event.decision)
```

The module docstring at lines 28–36 already states the position rather than hiding it:

> `/resume` is a bearer capability, and that is a deliberate Phase 2 position…
> Authentication and authorization are Phase 3's; until then this route refuses nothing,
> and the risk is recorded in the PR that shipped it.

Verified against generated output, not just source: built
`examples/scenarios/prior-auth-review` (profile `enterprise`, spec `0.30`) into a scratch
tree and read `app/generated/agents.py` (240 lines). The emitted `resume_agent` handler is
byte-for-byte the source above. **PASS — defect confirmed.**

### 1.2 Reproduction: an approval of one call resumes a different call

`AgentCheckpoint` (`runtimes/python/src/aid_runtime/agents/state.py:90`) is
`ConfigDict(frozen=True, extra="forbid")`. `frozen` prevents mutation *after* validation; it
does nothing about a body that was never authentic. There is no signature, expiry, nonce or
argument digest among its fields (`agent_id, step, messages, steps, calls, channel, when,
resume_kind, cost_anchor_usd, token_anchor, spent_usd, spent_tokens, degraded, alias, path,
memory_key, caller, escalation, guardrails`).

A script driving `runtimes/python`'s own harness (`tests/agent_support.py`, `solo(...)`,
`hitl={"when": ADMIN_ONLY, "channel": "ops"}`) pauses a run, tampers with the pending call's
arguments, and resumes it. Output:

```text
1. status after run              : paused
2. arguments shown to approver   : {'query': 'order'}
3. tampered arguments            : {'query': "a different customer's order"}
   (no signature field exists in the body: True )
4. model_validate accepted it    : {'query': "a different customer's order"}
5. resume completed              : True
6. tool executed with            : ["a different customer's order"]
```

The approver is shown `order`; the tool runs on `a different customer's order`. **The
approval decision and the approved payload are not bound to each other.**

### 1.3 A second, independent bypass the brief did not list

`runtimes/python/src/aid_runtime/agents/policy.py:36–46`:

```python
class Principal:
    roles: frozenset[str] = frozenset()
    scopes: frozenset[str] = frozenset()
    authenticated: bool = True
```

`AgentRuntime.run()` and `.resume()` (`loop.py:281` and `loop.py:307`) both read
`principal if principal is not None else Principal()`. The generated `/agents/{id}/run` and
`/agents/resume` handlers never pass a principal, so every agent run evaluates tool `auth:`
policies against `authenticated=True`. Evaluated directly:

```text
Principal() -> Principal(roles=frozenset(), scopes=frozenset(), authenticated=True)
isAuthenticated() -> True
hasScope('pa:write') -> False
```

This matters because `isAuthenticated()` is the *minimum* policy the compiler will accept on
a mutating tool — `tests/agent_support.py` says so: "The security gate rejects a
`write`/`destructive` tool with no `auth`, so this is the policy a mutating fixture tool has
to carry for the document to be one the compiler could actually have emitted." So the
smallest emit-able enterprise document has a mutating tool whose only authorization check is
satisfied by the runtime's default principal.

The blast radius is bounded in one direction and not the other:

- Pipelines **refuse** tool `auth` outright (`validate.ts:590`, `unsupported-tool-auth`: "the
  pipeline route has no authorization hook, so this predicate would not be enforced there").
  So the agent route is the only place `auth` is honoured — and it is honoured against a
  forged principal.
- `docs/guide/delivery.md:311–315` claims the opposite of the code: "The generated routes
  seed an *unauthenticated* principal when something branches on the caller, and it is
  deliberately not authenticated: a default authenticated principal would be a silent
  authorization bug." The default **is** authenticated. The doc describes the bug it
  warns about as the shipped behaviour it avoided.

This is recorded as a Phase A input (§8), not as a separate phase: it is the same file and
the same test fixture as the checkpoint work.

---

## 2. Item 2 — identity and durable state are claimed as shipped

### 2.1 The registry counts both

`site/scripts/features-data.mjs:258`:

```text
id: 'durable-state', title: "Durable run state",
detail: "… the checkpoint goes to the store the spec names, and an agent that can call a
         side-effecting tool is refused without one",
since: '0.1.143'
```

`features-data.mjs:420`:

```text
id: 'delivery-controls',
title: "Durable run state, deployment identity, private network and change approval",
since: '0.1.143'
```

A source comment near line 426 says the honest thing — "the generators that emit the store,
the identity check and the pause land in their own release, so this row does not claim they
exist yet" — but that comment is not published. The rendered row, and the count, are.

### 2.2 The code does not do it

- `state.urlEnv` / `DATABASE_URL` / `postgres` / `psycopg` / `sqlalchemy`: **zero** functional
  hits across `packages/generators/**/*.ts` and `runtimes/python/src/**/*.py`. The one
  mention in generated output is none — the generated enterprise app contains no reference
  to the declared store at all.
- `runtimes/python/src/aid_runtime/agents/memory.py` defines a `MemoryStore` protocol with
  exactly two implementations: `InProcessMemoryStore` (a dict) and `FileMemoryStore` (one
  JSON file). There is no `postgres` or `sqlite` adapter, though `AGENT_STATE_KINDS` in
  `packages/ir/src/shapes.ts` admits exactly those two.
- The generator says so itself. `packages/generators/py-fastapi/src/validate.ts:1491`:
  "a generated app registers no `MemoryStore`, so backend '…' cannot …".
- Identity: no `issuer`, `audience`, `Principal` construction or token verification is
  emitted. The only `Principal` constructions in the runtime are the two defaults in §1.3.

### 2.3 Every published sentence that implies otherwise

| File:line | Sentence | Reality |
| --- | --- | --- |
| `docs/reference/spec.md:773` | "AID compiles it into the generated app's token enforcement: a request whose token names another issuer or audience is refused, and the token's role and scope claims become the runtime `Principal`" | No token enforcement is generated |
| `docs/reference/spec.md:827` | "the generated enforcement pins the issuer literally" | no generated enforcement exists |
| `docs/reference/spec.md:831` | "the generated enforcement is the same claim check" | same |
| `docs/features.md:221` | "the checkpoint goes to the store the spec names" | no store is constructed from `state` |
| `docs/features.md:365` | "an `identity` reference (issuer, audience and claim names) that becomes the runtime `Principal`" | never becomes a `Principal` |
| `docs/index.md:24` | card title "Unprotected endpoints cannot ship" | `/agents/resume` refuses nothing (§1) |
| `docs/index.md:108` | "**Enterprise.** Declared identity, a private network, an audit sink…" | "declared" is accurate; the surrounding sentence reads as delivered |
| `packages/ir/src/shapes.ts` (`AgentStateShape` docstring) | "the generated code reads it at boot and the deploy refuses to start without it" | nothing reads it |
| `packages/ir/src/gates/delivery.ts:97,134` (gate hints) | "so a paused run has somewhere to wait" | the hint promises a store no generator emits |

`docs/guide/delivery.md:305–306` is **correct** and is the model for the fix: "Gated only.
**No token verification is generated**." So the repo already contains the honest framing in
one place and contradicts it in six others.

**FAIL — the repo overstates.** The registry must stop counting `durable-state` as shipped
until a store is generated, and `spec.md` must stop describing emitted enforcement.

---

## 3. Item 3 — the export gate does not look at what it protects

### 3.1 The brief's premise is half wrong, which makes the finding sharper

The brief says `aid trace export` covers pipelines and not agent runs. It covers agents:

- `packages/cli/src/commands/trace-export.ts` has `agentOf(run)`, which reads the agent id off
  the run's own spans, and `--filter agent=<id>` (`trace.ts:48`).
- The export **does** read the spec (`--spec`, default `app/app.spec.yaml`), runs it through
  `lowerSpec` with gates, and builds `policy.withheld` from
  `observability.redact ∪ observability.feedback.redact` (`trace-export.ts:285–296`).
- An `enterprise` document whose `withheld` is empty is refused
  (`traceExportEnterpriseCapture`, `trace-export.ts:296–307`).

So the published promise in `trace-export.ts:24–32` — "the spec decides what may be exported",
"the export applies the policy it declares" — is implemented. The problem is what the policy
covers.

### 3.2 The agent build refuses the only declaration that would cover agent text

`packages/generators/py-fastapi/src/validate.ts:196–233` refuses `observability.redact` on any
document that runs an agent:

```text
the document runs an agent and withholds email from its traces, but an agent run records the
transcript it was handed rather than a rendered prompt, so no emitted code can strip those
values; remove the declaration, or serve the same work through a pipeline
  [unsupported-redact]  at observability.redact
```

The reasoning is sound and honest: `PromptTemplate.render` (`runtimes/python/src/aid_runtime/prompts.py:115`)
is what pairs a declared field name with a value in the copy that gets recorded. An agent run
has no render boundary, so `redactions=` is never constructible for it. Confirmed by grep:
`redactions=` appears only where a template render produces it.

### 3.3 But `feedback.redact` satisfies the export gate anyway

`withheld` unions `observability.redact` **and** `observability.feedback.redact`. The second
governs *feedback payloads* — thumbs, corrections, escalation outcomes — not model-call text
(`packages/ir/src/gates/observability.ts:203–212`, `packages/ir/src/build.ts:2062`).

Therefore: an `enterprise` agent document that declares `observability.feedback.pii.redact:
[<any sensitive field>]` and no `observability.redact` **passes the enterprise export gate**
while nothing redacts the transcript the dataset is built from. The gate's own justification
— "a set is the proof, so it is required" — is satisfied by a set that has no bearing on the
payload it is meant to prove.

The shipped template is in exactly this posture: `examples/scenarios/prior-auth-review/app/app.spec.yaml`
declares `observability.feedback.pii.redact: [rationale]` and no `observability.redact`, and
`trace: true, export: otlp`.

**FAIL, and the failure is false assurance rather than absence.** Recorded as the Phase C
headline.

### 3.4 What must change for agent runs to be exportable with redaction

Not a new feature — a per-agent redaction surface that has a render equivalent. Options, in
increasing cost, for review:

1. **Refuse the escape hatch (cheapest, honest).** `trace export`'s `withheld` for a document
   that runs an agent must come from a set that actually applies to agent text; if none can
   exist today, the enterprise refusal must say "an agent run cannot be exported redacted"
   rather than accepting `feedback.redact`. Small, and it converts a false promise into a
   named refusal.
2. **Redact the transcript at the recording boundary.** The loop already knows message roles
   and step boundaries; a declared `observability.redact` set applied to the text it appends
   to `messages`/`steps` would give the agent path the equivalent of a render. This is what
   the current refusal says is impossible; it is impossible *without* a boundary, not
   impossible in principle.
3. Memory redaction is refused today (`memory.py:166–168`, "memory redaction is not
   implemented"), so option 2 must also state what it does about a persisted run.

---

## 4. Item 4 — trajectory evals are scripted, and say so

**PASS — the claim is accurate, and the code documents its own limit in the right words.**

`runtimes/python/src/aid_runtime/evals/agent_runner.py:23–29`:

> When the provider is a recorded transcript or a scripted fake, the model's choices are fixed
> input: the run verifies that the machinery around the model obeys the spec … It does not
> measure whether a model chooses those calls, because no model is consulted. Verifying model
> behaviour needs a pinned provider and belongs with the baselines, not with a gate.

Supporting facts:

- `providers/fake.py` provides `FakeProvider` and `ScriptedTurn`.
- Replay exists: `AID_EVAL_TRANSCRIPT` (`emit/evals.ts:74–81`, read at `evals.ts:678–686`) makes
  a run offline from a recording.
- **Recording does not exist.** No `--record` flag on any `aid eval` subcommand; no CLI path
  writes a transcript. So the replay half shipped and the capture half did not, which is the
  gap B1 closes.
- `TRAJECTORY_METRIC_MIN_VERSION = '0.31'` (`packages/spec/src/validate.ts:233`) gates
  `step-count`, `forbidden-tool`, `approval-respected`; `ir/eval-metrics` and
  `evals/trajectory` gates already exist. Approvals come from `EvalCase.approvals`, with
  `ApprovalPolicy.APPROVE/REJECT` as a named, opt-in shortcut.

What a recorded real-model trajectory needs (B1 scope): a capture path that writes
`AID_EVAL_TRANSCRIPT`-compatible files from a pinned provider run; a distinct `recorded`
marker so a case cannot be mistaken for `scripted`; and a stated split of what CI can assert
(replay determinism, policy, plumbing) from what only a live run can (model choice).

---

## 5. Item 5 — homepage defects

All four confirmed in `docs/index.md`, plus two more.

| # | Defect | Evidence |
| --- | --- | --- |
| a | Overlay example references paths the base does not define | The base example (lines 39–60) defines only `models.fast`, `prompts.greet`, `pipelines.hello`. The overlay block (71–81) opens `models.triage.modelId` and `agents.triage_agent.maxCostBudget`; the overlay (83–91) sets `models.triage.modelId` and `agents.triage_agent.maxCostBudget`. Comment says "abridged; the rest of the base is the example above", which is false. |
| b | Spec version shown as `0.2` | `docs/index.md:39` → `specVersion: "0.2"` |
| c | No Delivery playbook link in "Where to go next" | Lines 216–226 list getting-started, overlays-and-fleet, usage, support-copilot. No `guide/delivery.md`. |
| d | "What AID is not" silent on auth and durable state | Lines 196–203: runtime platform, targets/clouds, no-code builder. Nothing about identity or pause durability. |
| **e** | **The homepage's own YAML fails `aid validate`** | Extracting lines 39–60 verbatim and running `aid validate`: `app.spec.yaml:12:15: error: Nested mappings are not allowed in compact mappings [spec/yaml-syntax]`. Cause: `template: Reply in one sentence to: {{ message }}` — the second colon makes it a nested mapping. The first code block a visitor copies does not compile. |
| **f** | Hero tagline claims what item 2 disproves | Line 7: "build-time gates refuse an unsafe or impossible spec before any code exists" is true; but the page pairs it with the card at line 24 whose mechanism (§1) does not hold. |

Defect (e) is the highest-value homepage fix and was not in the brief: it is the block the
"Start in 60 seconds" button leads people to copy.

---

## 6. Item 6 — Azure and Kubernetes: decision record

### 6.1 Current refusal

`packages/ir/src/shapes.ts:1161`:

```ts
export const SPEC_CLOUDS = ['aws', 'gcp'] as const;
```

Declaring anything else is refused by the schema, not by a gate. Changing `cloud: aws` to
`cloud: azure` in the enterprise template produces:

```text
app.spec.yaml:205:5: error: must be one of "aws", "gcp" [spec/schema-violation]
    at deployments.prod.cloud
```

There is no `ir/` diagnostic, no hint, and no mention of what would have to exist. This
violates the "gates are the product" principle in a narrow way: the refusal is correct but
unhelpful, and it is indistinguishable from a typo.

Also note `azure` **is** a model provider (`shapes.ts:104`, in `PROVIDERS`), which makes the
name collision a real source of confusion for a reader who sees "azure" in the docs.

### 6.2 What each option actually costs

| Layer | Azure | Kubernetes |
| --- | --- | --- |
| Spec/IR | Add to `SPEC_CLOUDS`; a `RUNTIME_CLOUDS`/platform mapping (`shapes.ts:1393`, `AGENT_RUNTIME_PLATFORMS`) | A third deployment kind, or a `platform` alongside `cloud` |
| Infra modules | A full second module set (Container Apps or AKS, managed identity, Key Vault, VNet, Log Analytics) mirroring the AWS/GCP trees, byte-asserted fixtures and a `tofu validate` job | No cloud module; a Helm chart or manifests, plus a cluster-contract check |
| Identity/network/approvals | `identity.kind` needs an Azure AD arm; private network maps to VNet/private endpoints; audit to Log Analytics | Identity becomes cluster workload identity (cloud-dependent); private network is the cluster's; approvals unchanged |
| Capability matrix | New supported pairs; every pair needs an emitter and a committed example before it may be declared | Same, and `container` target already exists — this is nearer than it looks |
| Cost | Large: one cloud's worth of modules, fixtures and CI, times every capability added later | Medium: smaller than a cloud, but overlaps the existing `container` target |

### 6.3 Recommendation

**Defer both. Refuse them by name, and say why.**

1. Do not build either this round (as decided).
2. Replace the bare enum violation with a named diagnostic,
   `ir/cloud-unsupported`, that names the supported set and points at the capability matrix,
   so the refusal is a signpost rather than a schema error.
3. Record the trigger that would reopen it: *the first customer requirement that cannot be
   served on AWS or GCP*, or a paying deployment whose platform is Kubernetes. Until one of
   those exists, adding a cloud multiplies the fixture and CI surface for every capability
   the framework ever adds, and the matrix is the thing that keeps "refuse rather than
   approximate" true.

**Landed in 0.1.168.** Recommendation 2 is built: `deployments[].cloud` is no longer a schema
`enum`, so the refusal reaches the IR and is `ir/cloud-unsupported`, naming the supported set and
pointing at the capability matrix. Azure, Kubernetes, `k8s` and the rest of `UNSERVED_CLOUDS` are
refused that way; a value that is not a cloud name at all is still `ir/deploy-target-unknown`,
because there the fix is a spelling. No `specVersion` bump: the set of documents that build is
unchanged, and only the diagnostic moved. Recommendations 1 and 3 stand -- nothing was built, and
the reopening trigger is unchanged and now recorded in the published matrix, not only here.

---

## 7. New finding — a sensitive field name makes an agent document unbuildable

This was not in the brief. It is the most severe correctness defect found, because it is a
closed loop: every route a user could take is refused by a different gate, and no
configuration builds.

Reproduced on the enterprise template by adding one ordinary field named `email` to
`types.CoverageDecision`:

| Attempt | Refused by | Diagnostic |
| --- | --- | --- |
| omit `observability.redact` | py-fastapi generator | `unsupported-redact` at `observability.redact` (the builder **derives** `[email]` from the field name) |
| `redact: []` | security gate | `ir/security-redaction-incomplete` — "it is on but does not redact email, which the spec marks as sensitive" |
| `redact: [email]` | py-fastapi generator | `unsupported-redact` — "the document runs an agent and withholds email" |
| `trace: false` | observability gate | `ir/observability-export` — "declares `export: otlp` while `trace` is false" |
| `trace: false, export: none` | observability gate | `ir/observability-export` — "profile enterprise promises an audit trail, but observability exports `none`" |
| add `email` to `feedback.pii.redact` first | feedback gate | `ir/feedback-pii` — then the loop above repeats |

The gates are individually right. Together they make the class "an agent service that
handles a field called `email`" uncompilable, which is a large fraction of real enterprise
agents. The template escapes only because none of its field names is in the sensitive set.

**This belongs in Phase C and it cannot wait behind it**: the fix is either a redaction
boundary for agent text (§3.4, option 2) or an explicit, documented refusal that says the
combination is unsupported — but the current five-way blame loop is not a refusal, it is a
puzzle.

---

## 8. Re-ranked phases

Ordered by risk and by how much later work depends on them. Estimates are engineer-days of
focused work, including tests and the docs/registry corrections each phase owes.

| Order | Phase | Contents | Est. | Why here |
| --- | --- | --- | --- | --- |
| 1 | **A — resume integrity** | Signed (`HMAC`, secret **named** by env var, never inline) + expiring checkpoint; per-call argument digest; nonce/`jti` in the declared store; refuse tampered/expired/replayed; `ir/resume-unsigned`, `ir/resume-secret-inline`; **and** pass a real principal on agent routes so `Principal()` is not forged (kills the §1.3 bypass in the same file) | 4–5 | It is the only finding where an approval can be defeated *today*, and the fix is one emitter + one runtime module. Every later pause/durability claim is unfounded until it lands. |
| 2 | **B — truth of record** | Registry: stop counting `durable-state`/`delivery-controls` as shipped; split "declared and gated" from "generated"; add `identity.verifiedBy` under `enterprise`; correct `spec.md:773/827/831`, `features.md:221/365`, `delivery.md:311–315` (it is the code that is wrong, not the doc — fix the code to seed an unauthenticated principal); homepage §5 | 2–3 | Cheapest phase in the framework's own currency. Doing it after A means two registry churns; doing it before A means correcting a sentence that A then re-corrects. A then B keeps each claim true when written. |
| 3 | **C — agent redaction deadlock** | §7 closed loop and §3.3 false assurance: give agent runs a redaction boundary, or refuse the combination by name; `trace export` must not accept `feedback.redact` as proof for agent text | 4–6 | Blocks any enterprise agent that touches PII — i.e. the target customer — and it is the precondition for D. |
| 4 | **D — real-model trajectory evals** | Capture path that writes `AID_EVAL_TRANSCRIPT` recordings from a pinned provider; `recorded` marker distinct from `scripted`; state what CI asserts vs what needs a live run; repeat the limit in docs and walkthrough | 3–4 | Replay already shipped; only capture is missing, so this is smaller than it looks. Depends on C for any PII-bearing dataset. |
| 5 | **E — improvement loop end to end** | trace → curated dataset → candidate → `aid eval --compare` → approval → versioned release; promotion gate refuses a candidate that regresses quality or exceeds cost; never auto-promotes | 4–6 | The highest-value gap in the brief, but it sits on C and D: a dataset built from unredacted agent traces is not one you can promote from. |
| — | **F — Azure/Kubernetes** | Decision record only (§6). Replace the enum error with `ir/cloud-unsupported`. Build nothing. | 0.5 | Deferred by decision; the diagnostic improvement is the only code. |

---

## 9. Smallest first increment

Ship **A only**, in one PR, with these five properties:

1. `AgentCheckpoint` gains `issued_at`, `expires_at`, `nonce`, `signature`, and a digest over
   the pending calls' arguments.
2. The signing key is read from an env var the spec names
   (`state.signingKeyEnv` or equivalent) — a literal in the spec is refused by
   `ir/resume-secret-inline`, so the secret never enters git.
3. The generated `resume_agent` verifies signature, expiry, nonce (via the declared store) and
   the argument digest before `runtime.resume`, and returns a named refusal for each failure.
4. The nonce is recorded where `state` points. When no store is declared, `enterprise` is
   refused (`ir/resume-unsigned`) and `standard` is told in the hint that its checkpoint is
   signed but replayable — the limit stated, not implied.
5. Agent routes pass a real `Principal` (unauthenticated when nothing verified a token), so
   `isAuthenticated()` stops being free. This is the §1.3 bypass and it is the same emitter,
   the same fixture and the same test file as (1)–(4).

Tests that must exist before it can be called shipped: tampered body refused; expired body
refused; replayed nonce refused; wrong secret refused; argument digest mismatch refused; an
unauthenticated principal cannot drive a `write` tool. `docs/guide/delivery.md:305–320` and
`docs/index.md:24` are corrected **in the same PR**, because both make claims this PR makes
false or true.

---

## 10. Open questions for review

1. **Mutation, not just tampering.** §1.2 shows the decision is not bound to the payload. Is
   binding it via an argument digest in the checkpoint sufficient, or should the resume body
   carry the decision and the digest and let the server compare against its own record?
2. **Replay without a store.** The decision is "refuse `enterprise`, document the limit for
   `standard`". Confirm that `standard` keeping a signed-but-replayable checkpoint is
   acceptable, since that is a real (if bounded) exposure on the profile most mid-size
   customers use.
3. **`identity.verifiedBy`.** Should it be a free string naming the component ("our ALB +
   `business/auth.py`"), or an enum of integration points? The former is honest and cheap; the
   latter risks become a menu of things that are not built.
4. **§7 priority.** I have put the redaction deadlock in Phase C, behind A and B. The
   argument for moving it to A is that an unbuildable spec is worse than an unauthorized
   resume. The argument for keeping it in C is that A is a security defect in shipped code
   while §7 is a refusal in delivered code. I recommend keeping the order as written but want
   that called explicitly.
