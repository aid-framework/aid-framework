# RFC 0007 appendix — reviewing the signed resume checkpoint

| Field | Value |
| --- | --- |
| Status | **Review brief.** Docs only; no code changed. Findings are recorded, not fixed. |
| Phase | D (the last phase of round 7) |
| Affects | This file. Every other change in round 7 is in [RFC 0007](./0007-citation-gate.md). |
| Continues | [RFC 0004](./0004-round-4-resume-and-agent-loop.md) built the signature; this brief is its review |
| Verified against | Branch `nithin554-citation-gate-phase-c` at `a132ce4`, release `0.1.174`, spec `0.33` |

> **What this is for.** Round 4 shipped a signed, expiring, single-use resume checkpoint. It
> was written and tested by an agent, and the tests were also written by an agent. This is the
> checklist a person can walk in under an hour to decide whether they believe it.
>
> **What a reviewer should conclude at the end:** the checkpoint is unforgeable, expiring and
> single-use, and it is **not** owner-bound. Holding an unspent checkpoint is enough to resume.
> That is the documented division of labour — the app's own front door verifies the token — but
> it must be a decision someone made on purpose, not a property someone assumed.

---

## 0. How to use this

Nine items, each with a verdict against the code as it stands, the lines that decide it, and
the residual risk that survives. Read §1 first (2 minutes) because it reframes everything
else. Then work the items in the order given, which front-loads the ones that are cheap to
believe and expensive to get wrong.

| # | Item | Verdict |
| --- | --- | --- |
| 1 | Signature comparison is constant-time | **PASS** |
| 2 | Payload is canonically serialized; unknown and reordered fields | **PASS** |
| 3 | Domain separation: the secret is used only for checkpoints | **UNCLEAR** |
| 4 | Algorithm and key length; fixed rather than caller-selected | **FAIL** — algorithm PASS, key length FAIL |
| 5 | Expiry: clock source, skew, boundary | **PASS** with stated gaps |
| 6 | Rotation: two secrets for a window | **FAIL** |
| 7 | Replay: what is recorded, where, and the `standard` limit | **PASS** with a documented limit |
| 8 | Error responses do not leak an oracle to unauthenticated callers | **FAIL** |
| 9 | Arguments-hash binding | **PASS** |

Three of the failures are deliberate design choices with a documented cost (§2 items 4, 6,
8). One is a genuine gap nobody chose (§2 item 3). One is a source comment citing a
diagnostic that does not exist (finding D-1).

### What this brief could not execute

The environment has no working Python interpreter — `python` is the Windows Store stub, so
`import hmac` fails at the alias. **No Python test was run while writing this.** Items backed
by an existing test are marked with the test name; everything else is a reading of the code.
A reviewer with a working interpreter should run:

```bash
cd runtimes/python && pytest tests/test_agents_checkpoint_integrity.py -v
```

That file holds 12 tests, and they are the evidence for items 2, 5, 7 and 9:

| Test | Item |
| --- | --- |
| `test_a_pause_is_signed_and_names_its_own_expiry` (`:72`) | 5 |
| `test_an_edited_approval_decision_is_refused` (`:81`) | 2 |
| `test_swapping_the_held_call_arguments_is_refused` (`:93`) | 9 |
| `test_an_extended_deadline_is_refused_as_tampering` (`:108`) | 2, 5 |
| `test_a_genuine_expiry_is_refused` (`:127`) | 5 |
| `test_the_same_checkpoint_is_spendable_once` (`:153`) | 7 |
| `test_the_nonce_is_signed_so_it_cannot_be_swapped_to_replay` (`:167`) | 2, 7 |
| `test_an_unsigned_checkpoint_is_refused_by_a_signed_app` (`:185`) | 4 |
| `test_a_checkpoint_signed_with_another_key_is_refused` (`:197`) | 3, 4 |
| `test_a_runtime_without_a_signer_keeps_the_library_behaviour` (`:210`) | 7 |
| `test_the_signer_refuses_an_unset_or_empty_variable` (`:220`) | 4 |
| `test_the_signer_reads_the_named_variable` (`:228`) | 4 |

---

## 1. What the signature proves, and what it does not

Read this before item 1, because six of the nine items are asking "is the MAC computed
correctly" and the honest answer is *yes, and that is not the whole question*.

**Proved.** A checkpoint the app issued cannot be edited (`tampered`), cannot outlive its
deadline (`expired`), and cannot be presented twice (`replayed`). An app built with signing
refuses one it never issued (`unsigned`). The four checks live in one method each:
`CheckpointSigner.verify` at `runtimes/python/src/aid_runtime/agents/resume.py:294` and
`CheckpointSigner.accept` at `:323`.

**Not proved: who is resuming.** The emitted route takes its identity from
`current_principal`, and that function returns `ANONYMOUS_PRINCIPAL`:

- `packages/generators/py-fastapi/src/emit/agents.ts:451` — `ANONYMOUS_PRINCIPAL = Principal.unauthenticated()`
- `packages/generators/py-fastapi/src/emit/agents.ts:486` — the route depends on it

So `principal` reaches `AgentRuntime.resume` and is threaded into the run, and nothing in
the generated app has ever verified a token to produce it. Signing makes the checkpoint
unforgeable, not *owner-bound*: any party who holds an unspent checkpoint may resume it, and
resuming is the same act as approving the held call.

This is the gap round 4 closed in the honest direction rather than the impressive one: the
registry says identity is declared and gated, not generated, and the `enterprise` profile
requires `deployments.<id>.identity.verifiedBy` to name who verifies tokens. A reviewer
should confirm that this division of labour is stated where an operator will read it —
`docs/guide/delivery.md` — and that no page claims otherwise.

**Reviewer's question, and the only one that matters for this section:** if the app is
deployed without the front-door auth the profile made it declare, what stops a stranger
holding a leaked checkpoint from approving a write?

**Answer:** the TTL (default 15 minutes, `DEFAULT_CHECKPOINT_TTL_MINUTES`), single use, and
the fact that the checkpoint has to leak. Nothing else. That is the residual risk, and it is
a *deployment* risk the spec makes declarable rather than a building the generated code
supplies.

---

## 2. The checklist

### Item 1 — Signature comparison is constant-time

**Verdict: PASS.**

`resume.py:308` compares with `hmac.compare_digest(expected, integrity.signature)`. Both
operands are hex digests produced by the same code path, so this is a true constant-time
comparison and not a length-revealing `==`.

*What a reviewer should see:* that the comparison is on the digest, not on the payload, and
that a mismatch raises rather than returns. Both hold.

*Residual risk:* the operands are `str` rather than `bytes`, so CPython raises `TypeError`
for a non-ASCII operand instead of comparing. `integrity.signature` is attacker-supplied and
is declared as a bare `str` (`state.py:107`, `signature: str = ""` — no pattern, no ASCII
constraint). A non-ASCII signature therefore raises before the constant-time path, and the
route does not catch `TypeError`, so it is a 500 rather than a 403. Not a timing leak; a
robustness and log-noise finding. See **D-8**.

### Item 2 — Canonical serialization, unknown fields, reordered fields

**Verdict: PASS.**

`checkpoint_payload` (`resume.py:215`) serializes
`model_dump(mode="json", exclude={"integrity": {"signature"}})` (`:226`), then
`json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)`.
Signing and verifying both call it through `_digest` (`:260`), so the two sides cannot drift
to covering different bytes.

*What a reviewer should see:*

- **Reordered fields are neutral** — `sort_keys=True` makes field order unreachable as an
  attack, so there is no canonicalization ambiguity to exploit.
- **Unknown fields are refused before signing is consulted** — every model sets
  `extra="forbid"`: `CheckpointIntegrity` at `state.py:102`, `AgentCheckpoint` at
  `state.py:113`, and the three shapes nested inside them at `:70`, `:152`, `:178`. An extra
  key is a `ValidationError` at `AgentCheckpoint.model_validate` in the route, which the
  emitted handler turns into a 422 (`agents.ts:498`). The signature check never runs.
- **The integrity block's own `issued_at`, `expires_at` and `nonce` are inside the MAC.**
  This is the subtle one and it is right: excluding them would let a holder move their
  deadline forward, or swap the nonce of a spent checkpoint to walk past replay protection.
  The docstring says so at `resume.py:218-227` and
  `test_the_nonce_is_signed_so_it_cannot_be_swapped_to_replay` (`:167`) and
  `test_an_extended_deadline_is_refused_as_tampering` (`:108`) prove it.

*Residual risk:* `default=str` is inert today because `mode="json"` has already produced
JSON-native types, but it is a silent-collision hazard the day a field type is not
JSON-native — two distinct values would canonicalize to the same string. See **D-9**.

### Item 3 — Domain separation: the secret is used only for checkpoints

**Verdict: UNCLEAR.** This is the one item with no designed answer.

*What exists.* The secret is taken from an environment variable **named in the spec**, never
inlined, and `ir/resume-key-alias` (`packages/ir/src/gates/resume.ts:109`, registered at
`packages/ir/src/diagnostics.ts:74`, metadata at `:199`) refuses a `state.signingKeyEnv`
whose name collides with the store URL variable, a model `apiKeyEnv`, an
`observability.endpointEnv`, or a deployment `secret`. That is name-based domain separation
and it is a real control.

*What does not exist.* The MAC input is the bare canonical checkpoint JSON with no purpose
string, no protocol label, no app or deployment identifier
(`resume.py:215`; `_mac` at `:258` is `hmac.new(secret, payload, sha256)` and nothing else).
Consequences a reviewer should weigh:

1. Two AID apps deployed with the same secret will accept each other's checkpoints. The
   one-key-one-app property is enforced by a naming convention in one app's spec, not by the
   key material.
2. If an operator reuses that variable for anything else in the same process — a session
   cookie signer, a webhook verifier — the two are cross-usable. Nothing detects this.

*Fix direction (not this round):* prefix the payload with a constant context and the
project name, e.g. `b"aid.checkpoint.v1\0" + project + b"\0" + payload`. That is a
one-line change to `checkpoint_payload`, it invalidates outstanding checkpoints (which the
change is anyway compatible with, because §item 6 says there is no rotation window to
protect), and it needs a byte-asserted fixture. **D-4.**

### Item 4 — Algorithm and key length

**Verdict: FAIL** — the algorithm is right, the key length is unchecked.

- **Fixed, not caller-selectable: PASS.** `_mac` hardcodes `hashlib.sha256`
  (`resume.py:258`). Nothing in the spec, the emitted config or the environment can select
  `md5` or `sha1`. `CheckpointSigner` is a frozen dataclass with `slots=True` (`:236`).
- **Key length: FAIL.** The only checks are "not empty": `CheckpointSigner.__post_init__`
  (`:248`) raises on `not self.secret`, and `signer_from_env` (`:345`) raises on a missing
  variable. A one-character secret is accepted and produces a valid signature. The schema's
  `^[A-Z][A-Z0-9_]*$` pattern (`packages/spec/src/schema/spec.schema.json`,
  `state.signingKeyEnv`) constrains the *name*, never the value — by design, since the value
  is an environment variable and the build never sees it.

*What a reviewer should conclude:* HMAC-SHA256 with a short key is a weak MAC whose
security is the key's entropy, and AID cannot measure that at build time because it refuses
to read the value. The honest options are (a) check the value at runtime and refuse to start
below a floor, which is a behaviour change an operator can see, or (b) state the requirement
in the emitted docstring and the delivery guide. (a) is the AID-shaped answer: refuse rather
than approximate. **D-3.**

### Item 5 — Expiry: clock, skew, boundary

**Verdict: PASS** with two stated gaps.

| Question | Answer | Evidence |
| --- | --- | --- |
| Clock source | `time.time()`, integer seconds | `resume.py:281` (sign), `:314` (verify), `:331` (accept) |
| Injectable? | Test-only `now` parameter on `sign`, `verify`, `accept` | same lines |
| Boundary | Refused at exactly the deadline: `expires_at <= moment` | `:315` |
| Fail direction | Closed — the equal case is refused | `:315` |
| Skew tolerance | None | no leeway parameter anywhere |
| TTL source | `state.checkpointTtlMinutes * 60`, else runtime default | `agents.ts:135`, `resume.py:246` |

*Gap 1 — no leeway.* There is no allowance for clock skew, and the deadline is compared
against **each replica's own wall clock**. Replicas whose clocks disagree by more than the
remaining TTL will disagree near the boundary: one accepts, one refuses. With a 15-minute
default this needs a badly drifted host to matter, but a reviewer should note that nothing
detects the drift and the failure mode is a 403 that reads `expired`.

*Gap 2 — no monotonic guard.* A backwards clock jump (a VM restore, a manual `date`) extends
the life of every outstanding checkpoint for the size of the jump. Bounded by TTL plus jump.

*What is right and worth confirming:* expiry is checked **after** the signature
(`resume.py:308` then `:315`), so an attacker cannot use a tampered checkpoint as an expiry
oracle, and the TTL has no `None` form in the emitted constants — an undeclared
`checkpointTtlMinutes` omits the constant entirely (`agents.ts:135`) so the runtime
default is the only place the number lives rather than a drifting second copy.

### Item 6 — Rotation

**Verdict: FAIL.** There is one secret and no window.

`signer_from_env` (`resume.py:345`) reads exactly one variable into one frozen
`CheckpointSigner`. There is no key identifier in `CheckpointIntegrity` (`state.py:104-107`
— `issued_at`, `expires_at`, `nonce`, `signature`, nothing else) and no secondary
verification secret. Rotating the secret therefore invalidates every outstanding checkpoint
at once: they fail as `tampered`, which is the wrong reason and will confuse an operator
mid-incident.

*Why this is survivable, and should be said out loud rather than fixed this round:* the blast
radius is the TTL. With the 15-minute default, a rotation refuses at most the pauses opened
in the last 15 minutes, and a caller does not lose their intent — they are told to start the
run again (`resume.py:317-320` returns exactly that). A two-secret window (verify against
current and previous, sign with current, drop previous after `TTL`) would remove even that
and is a small, contained change. **D-5.**

*Reviewer's question:* does the operator-facing doc say "rotate this secret" without warning
that rotation drops in-flight pauses? If it does, that is the defect — not the absent window.

### Item 7 — Replay: what is recorded, where, and the `standard` limit

**Verdict: PASS** with the limit documented.

*Exactly what is recorded:* one row per spent checkpoint, holding the nonce and its
`expires_at`. Nothing else — not the agent, not the run, not the principal. `claim` is
`claim(nonce, expires_at, now) -> bool` (`resume.py:95`). The nonce is inside the MAC (§item
2), which is what makes the record trustworthy.

| Store | Atomic claim | Survives restart | Survives replicas |
| --- | --- | --- | --- |
| `InProcessNonceStore` (`:106`) | dict + `asyncio.Lock` (`:119-135`) | no | **no** |
| `SqliteNonceStore` (`:128`) | `INSERT OR IGNORE`, checks `rowcount == 1` (`:155`) | yes | one host only |
| `PostgresNonceStore` (`:161`) | `INSERT … ON CONFLICT DO NOTHING RETURNING nonce` (`:196`) | yes | **yes** |

The two-store design is deliberate and the reason is in the comments: a store that read then
wrote would let two concurrent requests holding the same checkpoint both through
(`NonceStore`, `:87-105`). Both durable stores use the database's own conflict detection
rather than a read-then-write, which is the property to check.

*The `standard` limit, stated plainly.* `nonce_store_from_env` (`resume.py:375`) returns the
in-process store when no `state.kind` is declared — `kind is None`. Under `standard` that is
accepted with `ir/resume-replay-weak` as a **warning**; under `enterprise` it is an **error**
unless the agent declares a store. The consequence an operator must understand: with the
in-process store, a resume is single-use *per process*, so a restart or a second replica
accepts the same checkpoint again. Signing still holds (the checkpoint is genuine and
unexpired); only the once-only property lapses.

*Also confirm:* a declared store whose variable is unset is a `ConfigurationError`, not a
silent fallback (`resume.py:388-400`). That is the right direction — silence would be the
unsafe default.

*Ordering, worth noticing:* `accept` verifies the signature **before** claiming the nonce
(`:323-343`), so an unsigned or tampered checkpoint never writes a row. An attacker cannot
fill the store.

### Item 8 — Error responses do not leak an oracle

**Verdict: FAIL.** The distinctness is deliberate, and it is still an oracle.

The emitted route (`agents.ts:481-505`):

- body is not a checkpoint at all → **422** with the pydantic error string
- checkpoint this app issued but will not honour → **403** with
  `detail = {"reason": ..., "message": ...}`

`reason` is one of four values set in `resume.py`: `unsigned` (`:303`), `tampered` (`:310`),
`expired` (`:317`), `replayed` (`:338`). **Nothing is logged** — there is no logger import and
no logging call anywhere in `resume.py` or the resume route, so today the only record of a
refusal is the response.

*The oracle, precisely.* `replayed` tells an unauthenticated caller three things they could
not otherwise know: the checkpoint is **authentic** (it passed the MAC), a nonce store
**exists and was written**, and this checkpoint is **spent**. Combined with `expired` versus
`tampered`, a caller can classify any checkpoint they hold without the secret. In a design
where the whole point was "an unprotected endpoint cannot ship", handing an unauthenticated
caller a validity classifier is the wrong trade.

*The design intent, which a reviewer may accept or reject but should not miss.* The emitted
docstring at `agents.ts:489-493` says the two refusals are kept apart on purpose "so a caller
can tell which without parsing prose". That is a good API for an **authenticated** caller
debugging their own pause, and a bad one for a stranger holding a stolen checkpoint. **D-7.**

*Fix direction (not this round, and it needs a decision first):* return one opaque 403 to an
unauthenticated principal and the detailed `reason` only when a principal was actually
verified — which today is never, because `current_principal` is anonymous (§1). The simplest
honest interim is to log the reason at warning level and return the coarse refusal; that
preserves operator debuggability and removes the classifier. Choosing between those is the
human owner's call, which is why this is a finding and not a patch.

### Item 9 — Arguments-hash binding

**Verdict: PASS**, and there is no separate hash — the whole payload is one signature.

The brief asks "what is hashed, and how a tool-argument change after pause is detected". The
answer is that both questions collapse into one: **everything except `integrity.signature` is
hashed** (`checkpoint_payload`, `resume.py:215`), including the pending calls and their
arguments, the approval channel, and the nested `caller` frames for a delegate pause. There is
no second digest to keep in step.

*How a swap is detected:* it changes the canonical bytes, so the single signature check fails
as `tampered` before anything the checkpoint carries is read. That ordering is explicit in
`AgentRuntime._accept` (`runtimes/python/src/aid_runtime/agents/loop.py:349-353`): "Called
before anything the checkpoint carries is read, so a tampered pending call is never
authorized, priced or observed." The approved calls are then taken **from the checkpoint**,
not from the request — `frame.messages.extend(await self._observe(frame, checkpoint.calls,
principal))` at `loop.py:387`. A caller cannot supply arguments; the request carries only the
decision.

*Worth confirming:* the decision itself is outside the MAC — `event.decision` is a separate
field on the request (`agents.ts:484`, consumed at `loop.py:327`). That is correct and not a
gap: `HumanDecision` is a closed enum, so the only thing an unauthenticated caller can choose
is approve-versus-reject on the exact calls that were recorded. There is no room in it for an
argument. `test_swapping_the_held_call_arguments_is_refused` (`:93`) and
`test_an_edited_approval_decision_is_refused` (`:81`) cover both halves.

---

## 3. Findings register

Recorded, not fixed. Each needs an owner who is a person.

| ID | Severity | Finding | Where | Owner action |
| --- | --- | --- | --- | --- |
| D-1 | Medium | `resume.ts`'s header names `ir/resume-secret-inline`, which is **not registered**. The concern is actually served by `ir/resume-key-alias` | `packages/ir/src/gates/resume.ts:24` vs `packages/ir/src/diagnostics.ts:71-74` | Correct the comment, or register the code and split the gate. Either way the comment must name a code that exists |
| D-2 | **High** | Signing is not owner-binding: `current_principal` is anonymous, so any holder of an unspent checkpoint may approve | `agents.ts:451`, `:486`; `resume.py:294-343` | None in code — confirm the division of labour is stated in `docs/guide/delivery.md` and that `deployments.<id>.identity.verifiedBy` is what enterprise is told to rely on |
| D-3 | Medium | No minimum secret length or entropy; only non-empty is checked | `resume.py:248`, `:345` | Decide: refuse to start below a floor, or state the requirement in the emitted docstring and the guide |
| D-4 | Medium | No domain separation or audience binding in the MAC input | `resume.py:215-232`, `:258` | Add a fixed context prefix plus the project name; ship a byte-asserted fixture |
| D-5 | Medium | No rotation window; one secret, no key id, rotation refuses all outstanding checkpoints as `tampered` | `resume.py:345`; `state.py:104-107` | Add a previous-key verification path that lapses after `TTL`; until then warn operators in the guide |
| D-6 | Low | No skew leeway; deadline compared against each replica's wall clock | `resume.py:315` | Decide whether a leeway knob belongs in the spec or whether drift is the operator's problem |
| D-7 | Medium | Unauthenticated caller can distinguish `tampered` / `expired` / `replayed` / `unsigned`, and nothing is logged | `agents.ts:481-505`; `resume.py:302-343` | Decide: opaque 403 to unauthenticated callers plus a logged reason, or keep the detail and document why |
| D-8 | Low | Non-ASCII `signature` raises `TypeError` in `compare_digest` → 500 instead of 403 | `state.py:107`; `resume.py:308` | Constrain `signature` to hex (a pattern, not just `str`) |
| D-9 | Low | `default=str` in the canonical payload could collapse distinct non-JSON values to identical bytes | `resume.py:232` | Raise instead of stringifying, so an unserializable field fails loudly rather than canonically |

**D-1 is the same class of error round 7 exists to close, and the new gate cannot see it.**
The citation gate reads `docs/` and the README; `resume.ts` is source. A source comment that
names a diagnostic is a claim about the registry, and nothing checks it. Extending the gate to
source comments is a candidate for round 8 — it is a small change to the file list the
extractor walks, and it would have caught this one.

---

## 4. Questions for the human owner

1. **D-2.** Is "any holder of an unspent checkpoint may resume" acceptable under `standard`,
   given the app is expected to verify the token first? If yes, it should be one sentence in
   `docs/guide/delivery.md` in the words an operator would use. If no, the profile needs a
   stronger requirement than a declaration.
2. **D-7.** Is a refusal reason worth an unauthenticated oracle? My reading is that it is not,
   and that logging it instead costs an operator nothing.
3. **D-3 and D-5.** Both are runtime-behaviour changes with operator-visible consequences. Do
   they belong in a spec version, or are they the app's business?
4. **D-1.** Should the citation gate walk source comments, or should the register forbid
   backticked codes in source prose? The first is more useful; the second is smaller.

---

## 5. Time-boxed review path

For a reviewer with 45 minutes and a working interpreter:

1. §1, five minutes. Decide whether you accept the division of labour. Everything else is
   detail by comparison.
2. Items 1, 2 and 4, ten minutes, with `pytest tests/test_agents_checkpoint_integrity.py -v`
   open. These are the ones the tests already answer.
3. Item 7, ten minutes. Read the three stores and confirm each uses the database's conflict
   detection rather than read-then-write.
4. Item 9, five minutes. Confirm `_accept` runs before the checkpoint is read.
5. Items 3, 5, 6 and 8, ten minutes. These are the findings; decide whether you agree with how
   they are ranked.
6. §4, five minutes. Answer as many as you can; the rest become round 8's input.

---

## 6. What this round did not do

- No finding above was fixed. Every one is listed for a human owner.
- No Python was executed; §0 says which verdicts rest on tests and which on reading.
- No spec change. The `enterprise`-profile requirements quoted here were shipped in round 4
  and are cited, not proposed.
- This document is under `docs/rfcs/` and, per the round's rules, stays out of the published
  site.
