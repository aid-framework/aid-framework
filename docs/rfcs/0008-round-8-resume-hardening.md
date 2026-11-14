# RFC 0008 — Round 8: resume hardening and the honesty of `network.private`

| Field | Value |
| --- | --- |
| Status | **Phase 0 complete. Stopped for design approval before Phase C.** No product code changed. |
| Phase | 0 of A–E |
| Affects | This file only. Phases A–E each get their own PR. |
| Continues | [RFC 0007 appendix](./0007-appendix-resume-review.md), which filed D-1…D-9 |
| Verified against | `origin/main` at `3a8b989`, release `0.1.174`, spec `0.33`, branch `nithin554-round-8-phase-0` |
| Runtime used | `runtimes/python/.venv/Scripts/python.exe` — CPython 3.12.15 |

> **What a reviewer must decide.** Two things, and one correction to the brief.
>
> 1. **Phase C design (blocking).** Owner-binding a checkpoint needs an identity the runtime
>    does not have. `Principal` carries `roles`, `scopes` and `authenticated` — **no
>    `subject`** (§4.1). The brief asks for "a keyed hash of the verified principal subject";
>    there is no subject to hash. Phase C cannot start until someone picks an answer.
> 2. **The rollout gate for owner-binding.** The generated default principal is
>    `ANONYMOUS_PRINCIPAL`. Binding a checkpoint to the principal therefore refuses *every*
>    resume in a stock generated app — including the ones that work today. That is correct
>    fail-closed behaviour and it is also a breaking change. It needs the same version-gated
>    rollout `ir/resume-unsigned` already uses (§4.2).
> 3. **Correction to the brief.** Round 7's appendix said the resume tests could not be
>    executed here. They can, and **12/12 pass** (§1.0). Verdicts in that appendix that rested
>    on "not executed" are now upgraded from reading to execution.
>
> Everything else in the brief reproduced. All nine findings are real (§2).

---

## 0. Method

Each item below was checked against the source, not against the brief or the previous
round's report. Where a claim is behavioural, it was **executed**, not read: two throwaway
probes drove the real `AgentRuntime` and the real signer, and are quoted inline. Neither probe
is committed — they exist to make the verdicts reproducible, and each is short enough to
retype from the transcript in §1.1 and §1.8.

Severity is the appendix's, unchanged. **PASS** means the finding is real and reproduces.

---

## 1. Phase 0 verification

### 1.0 Test suite execution — PASS (this corrects the appendix)

RFC 0007's appendix §0 recorded that no Python interpreter was available, so all twelve
checkpoint tests were reviewed by reading only. That constraint no longer holds:

```text
$ runtimes/python/.venv/Scripts/python.exe -m pytest tests/test_agents_checkpoint_integrity.py -q
12 passed in 0.24s
```

CPython 3.12.15, `aid_runtime` installed from `runtimes/python/src`. The suite covers signed
issue, edited approval, swapped arguments, extended deadline, genuine expiry, single use,
signed nonce, unsigned refusal, wrong key, no-signer behaviour, an unset/empty variable, and
that the named variable is read (`test_agents_checkpoint_integrity.py:72-234`).

**This does not change any verdict.** The tests assert the properties the appendix said they
asserted; the gap the appendix identified is that none of them asserts *owner* binding, and
that remains true. It does mean the appendix's "not executed" caveat should be struck.

### 1.1 Owner binding — PASS (finding is real, and worse than stated)

The brief says a checkpoint is "not owner-bound". It is not, and the consequence is sharper
than "no owner field": the **generated default principal is anonymous**, so owner binding as
specified would refuse every resume in a stock app.

Generated route (`packages/generators/py-fastapi/src/emit/agents.ts`):

- `:451` — `ANONYMOUS_PRINCIPAL = Principal.unauthenticated()`
- `:454-456` — `def current_principal() -> Principal:` returns `ANONYMOUS_PRINCIPAL`
- `:465` — the run route depends on `current_principal`
- `:486` — **the resume route depends on `current_principal` too**
- `:438-444` — the docstring is honest: the mounting app is expected to override the
  dependency; `identity.verifiedBy` names the replacement. The *default* is still anonymous.

The checkpoint carries no principal. `AgentCheckpoint` (`runtimes/python/src/aid_runtime/agents/state.py:110-146`)
has eighteen fields — `agent_id`, `step`, `messages`, `steps`, `calls`, `channel`, `when`,
`resume_kind`, `cost_anchor_usd`, `token_anchor`, `spent_usd`, `spent_tokens`, `degraded`,
`alias`, `path`, `memory_key`, `caller`, `escalation`, `guardrails`, `integrity` — and none is
an issuer, subject or role. (`caller`, `:137`, is the recursive *delegation frame*
`AgentCheckpoint | None`, not a human.)

Executed against the real runtime — issue as an admin principal, then resume the same
checkpoint as a viewer and as the anonymous principal:

```text
resume attempts against a checkpoint issued to Principal(authenticated, roles=admin):
  same principal (authenticated, admin) ACCEPTED  status=completed  tool_executions=1
  different principal (authenticated, viewer) ACCEPTED  status=completed  tool_executions=1
  anonymous / unauthenticated        ACCEPTED  status=completed  tool_executions=1
```

All three are accepted and the held write tool executes in each case. `payload contains
'subject': False`, `'roles': False`, `'authenticated': False`.

**So:** possession of an unspent, unexpired checkpoint is sufficient authority to approve the
pause it holds. That is the appendix's conclusion, confirmed by execution rather than reading,
and it is the correct characterisation of the current design — a bearer capability, documented
as such.

### 1.2 `Principal` has no `subject` — PASS (this contradicts the brief)

`runtimes/python/src/aid_runtime/agents/policy.py:47-49`:

```python
roles: frozenset[str] = frozenset()
scopes: frozenset[str] = frozenset()
authenticated: bool = False
```

`Principal` is a frozen dataclass with these three fields and a `unauthenticated()` classmethod
(`:51-55`). There is no subject, user id or token claim. A probe constructing
`Principal(authenticated=True, subject="alice")` fails:

```text
TypeError: Principal.__init__() got an unexpected keyword argument 'subject'
```

The brief's Phase C instruction — "include a keyed hash of the verified principal subject in
the signed payload" — cannot be implemented against the current type. This is the blocking
design question, worked in §4.1.

### 1.3 Signing-key strength — PASS

`runtimes/python/src/aid_runtime/agents/resume.py`:

- `:248-255` — `__post_init__` refuses `not self.secret` and `ttl_seconds <= 0`. Nothing else.
- `:257-258` — `_mac` = `hmac.new(self.secret.encode("utf-8"), payload, hashlib.sha256)`
- `:345-355` — `signer_from_env` reads `os.environ.get(variable, "")` and refuses only when it
  is empty.

A one-character secret is accepted by both paths. The signature is HMAC-SHA256, which is not
the weak part; the key is.

### 1.4 Domain separation — PASS

`_mac` (`:257-258`) signs the raw canonical payload:

```python
hmac.new(self.secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
```

No context string, no purpose prefix, no length prefix. The secret is also the only thing
`CheckpointSigner` is given (`:245-246`), so today the checkpoint is the only consumer — the
risk is prospective, not live. It becomes real the moment the same configured secret is used
for a second purpose, which nothing in the current design prevents.

### 1.5 Key rotation — PASS

`signer_from_env` (`:345-355`) reads exactly one variable and constructs exactly one
`CheckpointSigner`. `CheckpointIntegrity` (`state.py:91-108`) has `issued_at`, `expires_at`,
`nonce`, `signature` — no key id, no generation, no version. There is no second accepted key
and no way to distinguish which key signed a checkpoint, so rotating the secret invalidates
every outstanding pause with no overlap window.

Mitigating: the default TTL is `DEFAULT_CHECKPOINT_TTL_MINUTES * 60` (`:246`), i.e. 15
minutes, so the operational cost of a hard rotation is bounded to one pause window.

### 1.6 Expiry skew — PASS

`:314-320`:

```python
moment = int(time.time()) if now is None else int(now)
if integrity.expires_at <= moment:
    raise CheckpointRefusalError("expired", ...)
```

No leeway. The comparison is inclusive, so a checkpoint is refused at the instant
`expires_at == now`. Two hosts whose clocks differ by one second can disagree about whether a
checkpoint is still live, and the refusal is indistinguishable from a genuine expiry.

### 1.7 Error oracle — PASS

Generated resume handler, `packages/generators/py-fastapi/src/emit/agents.ts:505`:

```python
detail={"reason": refusal.reason, "message": str(refusal)}
```

`CheckpointRefusalError` carries four distinct reasons — `unsigned` (`resume.py:302`),
`tampered` (`:309`), `expired` (`:316`), `replayed` (`:337`) — and the route returns all four
to the caller, along with a prose message that states which condition failed. `resume.py`
contains no logger (`grep -n 'logger\|logging' runtimes/python/src/aid_runtime/agents/resume.py`
is empty), so there is no logged-instead-of-returned split at all.

An unauthenticated caller can therefore use the route as an oracle: present a checkpoint, read
whether the signature or the deadline failed, and learn the exact shape of a valid one.

### 1.8 Non-ASCII signature — PASS (proven by execution)

`resume.py:307-308` compares two `str` values:

```python
expected = self._digest(checkpoint)
if not hmac.compare_digest(expected, integrity.signature):
```

`_digest` returns `hexdigest()` — ASCII by construction (`:258`). `integrity.signature` is
attacker-controlled (`state.py:107`, `str = ""`). Python's `compare_digest` refuses non-ASCII
`str` input:

```text
ascii hex              -> False
non-ASCII (U+00E9)     -> TypeError: comparing strings with non-ASCII characters is not supported
non-ASCII (emoji)      -> TypeError: comparing strings with non-ASCII characters is not supported
```

`TypeError` is not caught anywhere on this path, so a checkpoint whose `signature` field
contains one non-ASCII character turns the refusal into a 500. Fail-closed, but a
distinguishable one: an attacker gets a different status code for "malformed" than for
"wrong", which compounds §1.7.

### 1.9 Canonical-serialisation collision — PASS (proven by execution)

`resume.py:226-233`:

```python
document = checkpoint.model_dump(mode="json", exclude={"integrity": {"signature"}})
return json.dumps(
    document, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
).encode("utf-8")
```

`default=str` silently stringifies anything `mode="json"` could not encode, and two distinct
values then produce identical bytes:

```text
str "1.0"        -> {"when":{"x":"1.0"}}
Decimal('1.0')   -> {"when":{"x":"1.0"}}
```

`when` is `dict[str, Any]` (`state.py:121`), so the collision is reachable. Two checkpoints
that differ only that way share a signature, and one verifies the other. The window is narrow
— it needs a caller able to place a non-JSON value into `when` — and the fix is one argument.

### 1.10 The `network.private` overclaim — PASS

Only one place in the build reads the key: `packages/ir/src/gates/profile.ts:208`. No
generator branches on it. The Bedrock AgentCore runtime hardcodes the opposite
(`packages/cli/src/infra/modules/agent-runtime.ts:339`):

```hcl
network_mode = "PUBLIC"
```

with a comment that says so. The container module (`packages/cli/src/infra/modules/container.ts`)
does build `aws_vpc.this` (`:275`), `aws_subnet.public`/`aws_subnet.private`, and
`aws_nat_gateway.this` (`:343`) behind `local.create_network` — but that is a **container-level
fact gated on `var.vpc_id` being empty**, not a consequence of the pin. That nuance is exactly
what the two false sentences get wrong.

**The accurate wording already exists** at `docs/reference/spec.md:774`:

> The generated container module already builds a two-AZ VPC with private task subnets and one
> NAT gateway, so the pin states a requirement rather than selecting a different module, and no
> gate refuses a cloud for lacking a private-placement module because no generator branches on
> this key yet.

Two published sentences contradict it:

| Location | Text | Why it is false |
| --- | --- | --- |
| `docs/guide/delivery.md:330` | "Gated and generated; a two-AZ VPC with private task subnets and one NAT gateway" | Attributes the generation to the pin. The pin is gated; the VPC is built regardless. |
| `site/scripts/features-data.mjs:618` → generated into `docs/features.md:516` | "What *is* generated: the region pin, the audit sink and the private-network setting reach the OpenTofu" | The private-network setting reaches no module. |

Already accurate, and unchanged by Phase A:

- `docs/guide/boundary.md:26` / `site/scripts/boundary-data.mjs:64` — "no module reads it"
- `docs/walkthroughs/delivery-controls.md:275-280` — "the private-network module … are not in
  this release"
- `docs/features.md:580`, `docs/migration.md:159-163` — describe the gate, not generation
- `packages/cli/src/templates.ts:470` — "`network.private: true` with `egress: declared-only`"

### 1.11 Registry honesty for identity and durable state — PASS

`site/scripts/features-data.mjs` keeps the two families out of the shipped count: they live in
`DECLARED_FEATURES` (`:601`) and `SHIPPED_FEATURES` begins at `:158`, so the counts on the
features page exclude them.

- `:608` (`durable-state`) is accurate: "The run itself is not persisted — the generated resume
  route hands the checkpoint back to the caller."
- `:618` (`delivery-controls`) is accurate about identity and durable state, and **false about
  the private network** (§1.10). It also names `ir/profile-identity, ir/identity-verified-by`
  as its enforcers (`:616`) but omits `ir/profile-network`, the one that actually gates the
  key it is describing.

### 1.12 Homepage copy — PASS (already honest; the remaining defect is elsewhere)

The brief's round-4-era concern that the homepage implies generated identity or generated
durable state **no longer reproduces**. `docs/index.md` states the opposite in both places:

- `:252-257` — "**Not your identity provider.** No token verification is generated… the
  enterprise profile's identity requirement is a declared responsibility rather than a
  generated check."
- `:258-262` — "**Not a durable run store.** A paused agent hands its signed, expiring
  checkpoint back to the caller…"

Two real copy defects remain, and both are Phase D's:

| Location | Defect |
| --- | --- |
| `docs/index.md:24` | Headline "**Prompt injection is a build error**". The body (`:25`) is accurate: the gate refuses a route that passes caller text to a prompt with no input guardrail. The *missing guardrail* is the build error; injection itself is not detected. |
| `docs/index.md:158-160` | "Enterprise … turns the controls into requirements: an identity block whose `verifiedBy` names the entry point …, a private network, …" — accurate as a list of *requirements*, but it does not distinguish what is generated from what is declared, which is what makes the §1.10 sentences read as true. |

Phase A closed the second row: `docs/index.md:160-163` now says "All of those are gated, and all but
two are generated", naming the private network and token verification as the two exceptions. Only
the headline remains for Phase D, so Phase D is one line of copy plus this record.

### 1.13 `release-plan` CI race — PASS

`.github/workflows/ci.yml:493-543`. The job runs only on `pull_request`, does
`git fetch --tags --force`, writes `git tag --list > tags.txt`, diffs
`git merge-base origin/$BASE_REF HEAD` against `HEAD`, then runs
`node scripts/version.mjs decide --tags-file … --changed-files-file …` and
`version.mjs verify`.

It compares the manifest version against the newest **tag**, and `release.yml` creates that tag
only after `main`'s CI passes. A PR pushed into that gap therefore sees a tag list missing the
release that `main` already contains, and `verify` fails. It is a race in the workflow, not a
defect in `scripts/version.mjs`, and it is why the failure was intermittent across rounds 7's
four PRs.

### 1.14 Source-code diagnostic drift — PASS, one occurrence

`files/scan-source-codes.mjs` (session probe, not committed) applied the round-7 checker's
namespace list and regex to `packages/*/src/**`, `runtimes/**`, `scripts/*.mjs` and
`site/scripts/*.mjs`, excluding `test(s)/` and `fixtures/`:

- 292 registered codes, 288 source files, 530 code-shaped tokens
- 46 unresolved or wildcard tokens — **one** in product source:
  `packages/ir/src/gates/resume.ts:24`, `ir/resume-secret-inline`

The rest are the checker's own fixtures, its regex-definition comments, and annotation strings.
That one occurrence is finding D-1:

```ts
 * - `ir/resume-secret-inline` — the signing key must be *named*, never carried, and must
 *   not be the same variable as the connection string.
```

It is not registered. The registry has `ir/resume-unsigned`, `ir/resume-replay-weak`,
`ir/resume-key-conflict`, `ir/resume-key-alias` (`packages/ir/src/diagnostics.ts:71-74`), and
`ir/resume-key-alias`'s own condition — "a signing key variable that already holds another
credential" (`:199`) — is precisely the condition `:24-25` describes. The comment is citing a
retired or imagined name for a real gate.

### 1.15 Code-scanning alerts #116, #117, #119 — PASS (false positives)

All three are `py/ineffectual-statement` on `...`.

- `runtimes/python/src/aid_runtime/evals/metrics.py:107` and `:111` — bodies of `Metric`, a
  `@runtime_checkable class Metric(Protocol)` (`:91`)
- `runtimes/python/src/aid_runtime/agents/resume.py:103` — body of `NonceStore.claim`, a
  `Protocol` (`:88`)

`...` in a Protocol method body is the body; it is not an ineffectual statement, and replacing
it with a docstring or `pass` does not change the meaning. These carry no security
consequence. Resolution is a written dismissal, not a code change — see §5.3 for the one
caveat.

---

## 2. Findings register

| ID | Finding | Verdict | Severity | Phase | Fix class |
| --- | --- | --- | --- | --- | --- |
| D-1 | `ir/resume-secret-inline` cited in a source comment, never registered | PASS | low | B | comment only |
| D-2 | Checkpoint is not owner-bound; the generated default principal is anonymous | PASS | **high** | C | runtime + generator + spec (gated) |
| D-3 | No minimum signing-key length or entropy check | PASS | medium | C | runtime |
| D-4 | No domain separation in the MAC | PASS | low | C | runtime |
| D-5 | No key rotation: one variable, no key id, no overlap | PASS | medium | C | runtime (+ optional spec field) |
| D-6 | No clock-skew leeway; expiry boundary inclusive | PASS | low | C | runtime |
| D-7 | Four distinct refusal reasons returned to unauthenticated callers, nothing logged | PASS | medium | C | runtime + generator |
| D-8 | Non-ASCII signature raises `TypeError` → 500, distinguishing malformed from wrong | PASS | low | C | runtime |
| D-9 | `default=str` lets two distinct payloads share a signature | PASS | low | C | runtime |
| — | `network.private` claimed generated in two published places | PASS | medium | A | docs + registry |

Eight of nine findings are confined to `runtimes/python/src/aid_runtime/agents/resume.py` and
its generator. Only D-2 reaches the emitted app and only D-2 can change a build's verdict.

---

## 3. Phase A — make `network.private` honest

No generator change. The `agent-runtime` module keeps `network_mode = "PUBLIC"` and its
existing comment, because changing it is a real feature (§3.1).

1. `docs/guide/delivery.md:330` — replace "Gated and generated; a two-AZ VPC with private task
   subnets and one NAT gateway" with the `spec.md:774` wording, and say plainly that the
   container module builds that VPC for every deployment it compiles while the pin selects no
   module.
2. `site/scripts/features-data.mjs:618` — move the private-network setting out of
   "What *is* generated" into "What is not", naming that no module reads it. Regenerate
   `docs/features.md` (the page is generated; do not hand-edit it).
3. `site/scripts/features-data.mjs:616` — add `ir/profile-network` to `enforces`, so the
   declaration names the diagnostic that actually gates it.
4. `docs/index.md:158-162` — separate what `enterprise` *requires* from what AID *generates*,
   in one clause, so the two sentences above cannot be read as true.
5. Acceptance: `gen-reference --check` is clean after regeneration, `check-docs-claims` passes,
   and no published page contains the string "private-network setting reach".

No spec change, so no version bump. The `declared`/`shipped` partition is already correct
(§1.11); only the sentence inside one declared feature is wrong.

### 3.1 The decision this round does not make

Whether AID should *build* private placement. Recorded, not implemented:

- **Work required:** the AgentCore runtime module needs a VPC, private subnets, a NAT or VPC
  endpoints, and a security group; `network.vpcId`/`subnetIds`/`privateEndpoints` are already
  in the schema (`docs/migration.md:139`) but consumed by nothing.
- **Cost:** a second module variant per network shape, new fixtures for each, and a capability
  cell per (cloud, target, network) triple — the matrix the gates would then have to refuse
  against.
- **Recommendation:** keep it declared-only for now, because the pin already does the job it
  was introduced for — it refuses an `enterprise` deployment that has not *stated* where its
  traffic goes — and because building it without a customer requirement risks a module nobody
  uses. Revisit when a real deployment needs traffic to stay off the public internet.

This is the honest position the docs must state, and §3 makes them state it.

## 3.5 Phase B — the citation check reaches source comments

§1.14 found exactly one drifting code in product source, which means the round-4/6 checker was
doing its job on prose and nothing else: a docstring could cite a gate that does not exist and
nothing failed, because the walk only opened Markdown. Phase B closes that, using the round-6
annotation vocabulary rather than a second one.

1. `scripts/check-docs-claims.mjs` — the markdown pass and the new source pass share one
   resolver. Scope is `packages/`, `runtimes/`, `scripts/`, `site/` and `examples/`, extensions
   `.ts .mts .js .mjs .py`, with `test/`, `tests/`, `fixtures/`, `__fixtures__/`, `__tests__/`,
   `*.test.*`, `*.spec.*` and `conftest.py` exempt: a fixture that names a bad code is asserting
   the checker's behaviour, not citing a gate.
2. `scripts/docs-claims.mjs` — `sourceCodeAnnotation` accepts the marker in `//`, `#` and bare
   block-comment form, because the packages are TypeScript and the runtime is Python and a
   check that understood one would cover half the tree. `fileCodeAnnotation` reads one
   `docs-claims-file:` marker from the first fifteen lines for a file that names bad codes
   throughout.
3. Exemptions are printed, never silent: `node scripts/check-docs-claims.mjs` lists each
   file-level exemption with its reason, so a reviewer sees what was excused.
4. Acceptance: appending `// a reintroduced claim: ir/resume-secret-inline` to
   `packages/ir/src/gates/resume.ts` fails with

   ```text
   packages/ir/src/gates/resume.ts:279: cites `ir/resume-secret-inline`, which no diagnostic
   registry declares; nearest registered: `ir/resume-key-alias`, `ir/resume-key-conflict`,
   `ir/resume-replay-weak`
   ```

   Removing it passes.

The one defect was not the only one in that docstring. Fixing D-1 meant reading the whole block,
which claimed "Three refusals" over four bullets, and claimed "each is an *error* only where the
profile promised the control" — true of `ir/resume-unsigned` and `ir/resume-replay-weak`, false
of `ir/resume-key-conflict` and `ir/resume-key-alias`, which are unconditional errors at
`resume.ts:108`, `:241`, `:253` and `:267`. The severity is decided at the `report` call site, not
stored per code in the registry, which is why the sentence could drift without a gate seeing it.
Both are corrected.

What this does not catch: prose in a source comment that asserts behaviour without naming a code.
That stays a review obligation.

---

## 3.6 Phase E — the `release-plan` race, fixed by removing the race

§1.13 found that `release-plan` compares the manifests against the newest **tag** while
`release.yml` mints that tag only after `main`'s CI passes. In the window between a releasable
merge and its tag, the tag list is a patch behind the manifests, `decide` derives its version
from tags alone, and a correctly stamped pull request fails `verify` with a mismatch that is not
real. §5.3 proposed waiting for the tag with bounded backoff. That would have made the window
survivable rather than impossible, and it leaves a second failure: a pull request branched
before the tag exists still plans the wrong number after the wait.

The version a pull request must stamp is a function of what the **base branch's manifests
declare**, and a manifest cannot lag — the stamp is committed with the change that needed it.
So the fix is to feed `decide` that number instead of the tag list:

1. `scripts/version.mjs` gains `declared`, which prints the tag every configured manifest in
   this checkout declares, and refuses a tree where they disagree, where one declares nothing,
   or where the value is not `x.y.z` — the last because `decide` would silently fall back to
   `bootstrapVersion` and plan a version nobody could mean.
2. `ci.yml`'s `release-plan` extracts the base branch with `git archive` into `$RUNNER_TEMP`,
   runs the *current* `declared` against that tree's manifests, and writes the single tag it
   prints to `tags.txt`. `decide` then plans `base + 1`, which is what the author read off
   `main` and stamped. The changed-file range still comes from `git merge-base`, so the release
   decision stays about this pull request's paths.
3. `git archive` rather than `git worktree` because a worktree rewrites `.git` state in the
   checkout CI is testing, and nothing else in the job should be able to observe that.
4. A base branch with no single version — only a checkout predating the first stamp — falls
   back to the tag list with a `::warning::`, so the bootstrap release still works.

Consequence worth stating: `release-plan` no longer reads tags at all, so its `tags.txt` and
`release.yml`'s are no longer the same input. They name the same version once `release.yml` has
caught up, and the comment in the workflow says so rather than claiming the two "cannot
disagree".

Six tests cover `declared`: the tag form, that its output makes `decide` plan the next patch,
disagreeing manifests, a missing version, a non-`x.y.z` version, and the committed tree itself —
the last because a PR that branches from a tree whose manifests are out of step would inherit
the confusion.

### The three code-scanning alerts

§1.15 proposed dismissing #116, #117 and #119 (`py/ineffectual-statement` on `...`) and §5.3
asked first whether the rule also fires on a docstring-only body. It does not: every module in
this repository opens with a bare string expression statement, and none is flagged, so the
query exempts a scope's docstring. That makes the `...` the redundant half of the pair: in
`Metric.name`, `Metric.deterministic` and `NonceStore.claim` the docstring *is* the body, so
removing `...` leaves a valid protocol stub that the rule has nothing to say about. Three lines
deleted, no behaviour change, `ruff` and `mypy` still clean. A dismissal would have been a
written exception for a fixable code smell.

## 3.7 Phase C — five things implementation changed about this plan

Recording these here rather than in the pull request, because four of them are corrections to
what §4 said and one is a defect this round found in code that was already shipped.

**1. The rollout is 0.34, not 0.33.** §4.2 argued for 0.34 and an earlier draft of the
implementation used the existing `IDENTITY_VERIFIED_BY_MIN_VERSION` (`0.33`) to avoid adding a
version. That was wrong for the reason §4.2 already gives: a spec version is the only thing a
document carries that says which rules its author was writing against. Escalating under 0.33
would refuse, in this build, documents that built yesterday — and nothing distinguishes them
from documents written today. So `'0.34'` is in `SUPPORTED_SPEC_VERSIONS`, in the schema enum,
and `RESUME_OWNER_BINDING_MIN_VERSION` names it; `docs/migration.md` and the spec changelog say
that 0.34 adds no grammar and exists to date a rule. A test asserts 0.33 is silent.

**2. Clock leeway changes an existing test's premise.** §4.6 added 30 seconds of leeway, which
makes a checkpoint signed with an expiry slightly in the past acceptable where it previously
refused. The runtime test that proved "expired is refused" now pins the clock far enough past
the expiry to be outside the leeway, and a second test proves the boundary: inside the leeway,
accepted; outside, refused. The old test would have passed either way and silently stopped
testing anything.

**3. A generator bug made the opaque 403 non-functional, and no gate caught it.**
`pythonString()` returns a literal, not an assignment. Used alone as a block, `RESUME_REFUSED`
was emitted as a bare module-level expression — valid Python, so `ruff`, `mypy` and the type
checker all accepted it — while the route's `detail=RESUME_REFUSED` referenced a name that did
not exist. Every refusal would have been a `NameError` and therefore a 500. The fix is to emit
the assignment; the test asserts that spelling, so a future constant cannot repeat it. Worth
naming plainly: this is the class of defect the round's own citation gate cannot reach, because
the emitted file is correct Python and only wrong at runtime.

**4. `deep_agents.py` was never given the principal.** Threading `Principal.subject` through the
native loop left the deepagents engine calling `_guardrail_text`, `_pause`, `_complete` and
`_guardrail_tool_calls` without it — a real gap, caught by `mypy` and by the seventeen
deepagents tests, not by review. It is the argument for `_pause` and `_complete` taking
`principal` explicitly rather than reading instance state: a missed call site is a type error
instead of a checkpoint that silently carries `owner=""`.

**5. The reference generator's constant lookup now accepts a type annotation.**
`{const:RESUME_OWNER_BINDING_MIN_VERSION}` could not resolve because the constant is declared
`: SpecVersion`, and the extractor only matched the bare spelling. Widening the pattern was the
right fix: the annotation is the same fact written more carefully, not a different one. The
alternative — dropping the annotation to satisfy a doc generator — would have let a
documentation tool constrain the source.

Two supporting changes: `.github/CODEOWNERS` now names the resume surface explicitly, so the
review requirement in §5.2 survives a second maintainer; and the example's two resume tests
assert the opaque body rather than `detail["reason"]`, which is what §4.7 asked for and what the
old tests could not have caught.

---

## 4. Phase C — resume hardening

**This section is a design proposal and needs approval before any code is written.**
Approval means: pick an answer in §4.1, accept the rollout in §4.2, and confirm the review
route in §5.2.

### 4.1 Owner binding needs an identity that does not exist

The brief asks for "a keyed hash of the verified principal subject in the signed payload at
pause time". `Principal` has no subject (§1.2). Three options:

| Option | Mechanism | Cost | Problem |
| --- | --- | --- | --- |
| **A (recommended)** | Add `subject: str \| None = None` to `Principal`; bind on `(authenticated, subject)` | Runtime field with a default; no spec change | The generated `current_principal` still returns anonymous, so no generated app sets it until it overrides the dependency |
| **B** | Bind on `(authenticated, roles, scopes)` | No new field | Interchangeable within a role, and a role change between pause and resume strands a legitimate checkpoint. Also a set, so canonicalisation must be ordered |
| **C** | Do not bind; document the bearer nature and refuse `enterprise` pausable agents without a declared verifier | Documentation only | Leaves D-2 open, which is the one high finding |

A stores no PII: the payload carries `HMAC(secret, subject)` under the same domain-separation
prefix as §4.4, not the subject itself. B has the appeal of requiring no new field and the
defect of binding to something that legitimately changes. C is honest but is not a fix.

**Recommendation: A.** It is one additive runtime field, it is the only value that is stable
across a pause, and it composes with `identity.verifiedBy`, which already names who is
responsible for producing it.

### 4.2 Rollout: owner binding must be version-gated, or it breaks every shipped app

The generated default principal is anonymous (`agents.ts:451`). If `accept` requires the
checkpoint's owner hash to match the resuming principal, then every stock generated app — which
has no subject on either side — refuses every resume. Two anonymous principals would in fact
hash equally, so the naive form silently *passes*; the refusal only appears once an app
overrides `current_principal` for run but not for resume.

Neither outcome is acceptable by accident, so Phase C mirrors the mechanism already proven for
`ir/resume-unsigned` (`packages/ir/src/gates/resume.ts:42`, `:124`, `:156-158`):

- `RESUME_OWNER_BINDING_ENFORCED_MIN_VERSION = '0.34'`
- Under `enterprise` at spec ≥ 0.34: refuse a pausable agent whose deployment declares no
  `identity.verifiedBy`. New diagnostic `ir/resume-owner-unbound`, message naming the route,
  the missing declaration, and the fix.
- Under `standard`, and under `enterprise` before 0.34: warn with the limit stated — a
  checkpoint is a bearer capability for the caller that holds it.
- Runtime: when the signer is configured and the resuming principal carries no subject,
  refuse `unbound` **only** if the checkpoint records an owner. A checkpoint issued by an app
  with no subject records no owner, so anonymous-to-anonymous continues to work until a
  deployment opts in by overriding the dependency. This is what keeps the change additive.

### 4.3 Key strength

`MIN_SECRET_BYTES = 32`. Refuse in `CheckpointSigner.__post_init__` (`resume.py:248`) on
`len(secret.encode("utf-8")) < MIN_SECRET_BYTES`, and in `signer_from_env` (`:350`) with a
message naming the variable and the minimum. Not a build gate: the value is an environment
secret, so the build cannot see it, and a gate that cannot inspect the value would be
decoration. The `ir/resume-unsigned` hint already tells an author which variable to set; its
text should gain the minimum.

### 4.4 Domain separation

```python
_CHECKPOINT_DOMAIN = b"aid.checkpoint.v2\x00"
hmac.new(self.secret.encode("utf-8"), _CHECKPOINT_DOMAIN + payload, hashlib.sha256)
```

Constant, module-level, not a parameter — the algorithm stays fixed rather than
caller-selectable, which §4.5 depends on.

### 4.5 Rotation

`signer_from_env` reads `{variable}` and, when set, `{variable}_PREVIOUS`. The signer holds
`secret` and `previous: str | None`; `verify` computes the MAC under the current secret, then
the previous one, and reports `tampered` only when both fail. New checkpoints are always signed
with the current secret. A build-time check refuses a deployment whose two derived names
collide, but since the names are derived rather than declared there is no way for an author to
misconfigure them — so this is a runtime assertion, not a gate, and no spec field is added.

The window in which both are accepted is however long the operator leaves `{variable}_PREVIOUS`
set; document that it must exceed the checkpoint TTL.

### 4.6 Expiry and skew

`CheckpointSigner` gains `leeway_seconds: int = 30`. `verify` refuses when
`integrity.expires_at + self.leeway_seconds <= moment`. The boundary is documented as inclusive
on the leeway: a checkpoint is live while `moment < expires_at + leeway`. The clock source stays
`time.time()` (`:314`), unchanged, so the leeway is the only tolerance and it is explicit.

### 4.7 Error responses and logging

The generated route returns one opaque 403 body for all refusal reasons — a fixed message and
no `reason` field — and logs the specific reason with the agent id and the nonce, so an operator
keeps the information and an unauthenticated caller loses the oracle. The generator gains a
module-level `logger = logging.getLogger(__name__)` in the emitted router.

Distinguish the status codes deliberately: 403 for every authentication-and-freshness failure
(`unsigned`, `tampered`, `expired`, `replayed`, `unbound`), 422 only for a body that fails
validation before the signer is reached.

This is a behaviour change to the emitted route, so it belongs in the same version bump as
`ir/resume-owner-unbound` and gets a migration note.

### 4.8 Malformed signatures

Both sides of the comparison become bytes:

```python
if not hmac.compare_digest(expected.encode("ascii"), integrity.signature.encode("utf-8")):
```

`expected` is always ASCII hex; `integrity.signature` of any length or encoding is then a
comparison that returns `False` rather than raising. No validation regex needed, and no path
reaches `TypeError`.

### 4.9 Canonical payload

Drop `default=str` (`resume.py:232`). Keep `sort_keys`, `separators=(',', ':')` and
`ensure_ascii=False` — those make the encoding reproducible, which is the requirement.
`model_dump(mode="json")` already yields JSON-native values for every declared field; if a
`when` value is not JSON-native, the honest answer is a typed refusal rather than a silent
stringification that can collide:

```python
except TypeError as error:
    raise ConfigurationError(
        "a checkpoint field is not JSON-serialisable, so it cannot be signed canonically"
    ) from error
```

Add a test asserting the two payloads of §1.9 no longer collide.

### 4.10 Format version and in-flight checkpoints

`CheckpointIntegrity` has no version field (§1.5). Rather than add one — which would itself
change the signed bytes for every new checkpoint — the domain prefix is bumped to
`aid.checkpoint.v2`, which **deliberately invalidates every checkpoint signed before Phase C**.
A pre-change checkpoint then fails with `tampered` under the new signer, which is a refusal, not
a silent accept.

That is safe because it costs at most one TTL: `DEFAULT_CHECKPOINT_TTL_MINUTES * 60` is 15
minutes (`:246`). The migration note says exactly that, and says the deployment should be
restarted to drain pauses before upgrading if a 15-minute window matters.

Verified: an unsigned checkpoint from before the signed rollout already behaves this way —
`verify` sees `integrity is None` and refuses `unsigned` (`:300-306`), asserted by
`test_agents_checkpoint_integrity.py:185`. There is no path where an old checkpoint is silently
trusted.

### 4.11 Tests Phase C changes

None removed or weakened. `test_agents_checkpoint_integrity.py` keeps all twelve as-is (they
construct `CheckpointSigner(secret="a"*64)`, so the 32-byte minimum is satisfied and the TTL
assertions still hold). Added:

| Test | Asserts |
| --- | --- |
| owner bound to subject | a checkpoint issued to a subject is refused for a different subject |
| anonymous-to-anonymous | still accepted, so the change is additive (§4.2) |
| owner absent but present in checkpoint | refused `unbound` |
| short secret | `CheckpointSigner` and `signer_from_env` refuse under 32 bytes |
| previous secret | a checkpoint signed with `_PREVIOUS` verifies inside the window |
| leeway | live at `expires_at + leeway - 1`, refused at `expires_at + leeway` |
| non-ASCII signature | refused, not raised |
| payload collision | the §1.9 pair no longer shares bytes |
| opaque refusal | the emitted 403 body has no `reason` field; the reason is logged |

---

## 5. Phases, order and review

### 5.1 Order and effort

| Phase | Scope | Depends on | Effort | PR rule |
| --- | --- | --- | --- | --- |
| 0 | This RFC | — | done | no code |
| A | `network.private` honesty, 4 edits (§3) | — | small | normal review |
| B | Extend the citation gate to source; fix D-1 | — | small | normal review |
| D | Homepage copy: `index.md:24` headline, `:158-162` split | — | small | normal review |
| E | `release-plan`: plan from the base branch's manifests, not the tag list (§3.6) | — | small | normal review |
| C | Resume hardening (§4) | **human approval of §4.1 and §4.2** | large | **no admin bypass; CODEOWNERS; human reviewer** |

A, B, D and E are independent and touch disjoint files, so they can run in parallel. C is
last because it changes emitted behaviour and needs the review.

### 5.2 Review rules for Phase C

- **No admin bypass.** The PR merges only on a human approval.
- **CODEOWNERS** must gate `runtimes/python/src/aid_runtime/agents/resume.py`,
  `runtimes/python/src/aid_runtime/agents/state.py`,
  `runtimes/python/src/aid_runtime/agents/policy.py`,
  `packages/ir/src/gates/resume.ts` and
  `packages/generators/py-fastapi/src/emit/agents.ts`. This is a new file;
  `.github/CODEOWNERS` does not exist today, so adding it is part of Phase C's PR.
- Every changed test listed with its reason (§4.11).
- The reviewer walks RFC 0007's appendix checklist again against the new code; each item must
  move from FAIL/UNCLEAR to PASS or be recorded as an accepted residual risk.

### 5.3 Phase E and the code-scanning alerts

The `release-plan` fix shipped differently from this section's first draft, which proposed
polling for the tag covering the merge base with bounded backoff. Backoff shortens the window;
it does not remove it, and a branch cut before the tag exists still plans the wrong number after
waiting. The base branch's manifests are the version, and they cannot lag, so `plan` now derives
the expected tag from them via the new `declared` command (§3.6). `release.yml` still diffs the
real tag list, because there the tags are the question rather than an input to someone else's
answer.

Alerts #116, #117 and #119: §1.15 proposed dismissal, and this section asked whether
`py/ineffectual-statement` also fires on a lone docstring body. It does not — every module in
this repository opens with a bare string expression statement and none is flagged. So the
docstring is the body and the `...` is the redundant statement: three deletions resolve all
three alerts with no behaviour change and no written exception (§3.6).

---

## 6. Where the brief and the repo disagree

1. **"a keyed hash of the verified principal subject"** — there is no subject (§1.2). This is
   the blocking design question.
2. **The generated default principal is anonymous** (`agents.ts:451`), so owner binding as
   specified is a breaking change to every shipped app, not an additive hardening. Hence the
   version gate in §4.2, which the brief does not mention.
3. **The homepage no longer implies generated identity or durable state** (§1.12) — it denies
   both explicitly. The surviving copy defect is the "Prompt injection is a build error"
   headline and an enterprise list that does not separate generated from declared.
4. **`docs/walkthroughs/delivery-controls.md:275-280` is honest**, not an overclaim: it says the
   private-network module is not in this release. The two false sentences are elsewhere (§1.10).
5. **Round 7's "tests not executed" caveat is void** (§1.0): 12/12 pass.
6. **`ir/resume-secret-inline` describes a condition that is already registered** as
   `ir/resume-key-alias` (`diagnostics.ts:199`). D-1 is a stale name, not an unbuilt gate.

---

## 7. What Phase C would still leave open

Stated now so the release notes can state it too:

- **A checkpoint remains a bearer capability under `standard`.** Signed, expiring, single-use,
  and — after Phase C — owner-bound only where a deployment has a subject to bind to. The
  `standard` warning says so.
- **The generated app still does not persist the paused run.** A checkpoint returns to the
  caller; where it is kept is the application's decision. Unchanged by Phase C.
- **No token verification is generated.** `identity.verifiedBy` names who does it. Unchanged,
  and the registry keeps saying so (§1.11).
- **`network.private` still selects no module.** Phase A makes the docs say that; it does not
  make it untrue-but-fixed.
