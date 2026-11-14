# RFC 0009 — Round 9: generated-app smoke tests and CI hardening

| Field | Value |
| --- | --- |
| Status | **Draft.** Phase 0 complete. Stopped for review before Phase A. No product code changed. |
| Phase | 0 of A–E |
| Affects | This file only. Each phase gets its own PR. |
| Continues | [RFC 0008](./0008-round-8-resume-hardening.md), which closed Round 8's resume hardening. |
| Verified against | `origin/main` at `c6ac24d`, release `0.1.178`, branch `nithin554-round-8-phase-c` |
| Runtime used | `runtimes/python/.venv/Scripts/python.exe` — CPython 3.12.15 |

> **What a reviewer must decide.** One reordering and one contradiction.
>
> The reordering: the brief puts generated-app smoke tests first. Phase 0 found that generated
> apps are already booted in three CI jobs, and that the linters which would have caught the
> Round 8 defect are already configured for those trees but never pointed at them. The smallest
> first increment is therefore not a smoke job — it is three lines of configuration in
> `check-all.mjs` (§3, Phase A).
>
> The contradiction: the brief says PR #221 is open and must not be touched. It merged before
> this round began (§1.4, §4.1).

Test and CI hardening only. No product features, no spec changes, no new diagnostics, and no
changes to the resume implementation.

The brief for this round rests on a premise that Phase 0 found to be false: that generated
applications are not booted in CI, so a defect like the Round 8 `RESUME_REFUSED` name error
could not be caught. Generated applications *are* booted, in three separate jobs. What actually
let that defect through is narrower and cheaper to fix: the linters that would have caught it
already exist, are already configured for the generated trees, and are simply never pointed at
them.

That changes the smallest first increment, so §3 reorders the phases. Everything else below is
PASS/FAIL/UNCLEAR against the seven Phase 0 items, with the command or `file:line` that
produced it.

## 0. Method

Every claim in §1 is backed either by a `file:line` citation or by command output reproduced in
the text. Where the two disagree, the command wins. Probes that mutate a file work on a copy in
`$TEMP`, never in the tree.

The tree under test is `main` at `c6ac24d`.

## 1. Phase 0 verification

### 1.1 What actually exercises a generated app — PASS, and more than the brief assumes

The brief implies generated apps are only generated. Three CI jobs boot and drive them.

**`e2e`** (`ci.yml:294`, runs `pnpm e2e` at `:341` → `scripts/e2e-example.mjs`) boots the
example, drives real HTTP, and asserts five things:

| Assertion | Location |
| --- | --- |
| regenerating is a byte-identical no-op | `assertRegenerationIsANoOp`, `e2e-example.mjs:198` |
| the spec alone reproduces the tree | `assertSpecAloneReproducesGeneratedCode:235` |
| `POST /tickets/answer` → 200, `category === 'billing'`, non-empty summary | `assertRegeneratedAppAnswers:401` |
| `POST /agents/{id}/run` → `paused` with a non-null checkpoint | `:438-441` |
| `POST /agents/resume` → `completed` with the scripted answer | `:444-459` |

**`evals`** (`ci.yml:155`) runs `pytest` with `cwd: examples/support-copilot`
(`check-all.mjs:199-205`). The example's `tests/test_agents.py` imports `app.generated.agents`
and drives the app through `TestClient`, so that job boots the generated code as an ASGI app.

**`guarded-reply`** (`ci.yml:218`) does the same for the second example
(`check-all.mjs:206-210`).

So the answer to "is a generated app booted?" is yes, three times over. The gap is narrower.

**The gap.** `assertRegeneratedAgentPausesAndResumes` resumes exactly once, with the checkpoint
it was just handed (`:444-459`). It never presents a tampered checkpoint, never resumes twice,
and never asserts a refusal. `RESUME_REFUSED` is referenced at `app/generated/agents.py:327`
and only reachable on the refusal path, so no job executes the line. The Round 8 defect was a
`NameError` on that path and nothing in CI touches it.

### 1.2 Can both templates generate and start in CI — generate PASS, start FAIL, and the FAIL is by design

Generate:

```text
aid init <dir> --template enterprise-approvals --gen   → 35 files, ~1.2s
```

Both templates generate. Neither emits `pyproject.toml` or `app/main.py`:

```text
pyproject.toml: False
app/main.py: False
file count: 35
```

This is deliberate, not a bug. `packages/cli/src/commands/dev.ts:10-22` states the contract:
the Python target emits routers, and the application owns `app/main.py` and decides what to
mount. `aid dev` therefore refuses when the entry is absent (`dev.ts:152-163`).

Consequence for the brief's Phase A: a job that boots a *template* tree must supply its own
`app/main.py` and `pyproject.toml`. It would then be testing the harness's bootstrap, not
anything AID generated. That is still worth having, but it proves less than the brief implies
and should say so.

Consequence for effort: booting a template tree is a new harness. Extending the existing
`e2e` job with refusal assertions is three assertions against a server that is already running.
The second is an order of magnitude cheaper and covers the defect that actually shipped.

### 1.3 Routes per template — PASS, enumerated

| Spec | Routes |
| --- | --- |
| template `enterprise-approvals` | `POST /triage`, `POST /agents/{agent_id}/run`, `POST /agents/resume` |
| template `support-copilot` | `POST /reply`, `POST /agents/{agent_id}/run` — **no** `/agents/resume` |
| example `examples/support-copilot` | `/tickets/answer`, `/agents/{id}/run`, `POST /agents/resume` (`app/generated/agents.py:299`) |

**The template `support-copilot` and the example `examples/support-copilot` are different
applications with the same name.** The template declares a Triage agent with
`guardrails: [message_injection]` and no approval pause (`packages/cli/src/templates.ts:21`),
so it has no resume route. The example declares `refund_agent` with `humanInTheLoop`, so it
does. Any smoke job must read its routes from the spec it generated rather than assuming the
example's surface.

### 1.4 Which branch the job tests — MOOT: the brief describes a state that no longer exists

The brief says PR #221 "is deliberately open for human review" and must not be merged, rebased,
closed or pushed to, and asks how a CI job should pick the branch under test when a PR is
pending.

```text
gh pr view 221 --json state,mergedAt,mergeCommit
→ "state":"MERGED","mergedAt":"2026-11-14T11:08:21Z",
  "mergeCommit":"a70e933e9234b814e3bdd31e159a49857f7d2acb"
```

Pull request #221 merged, #222 merged after it, `main` is `c6ac24d`, and the open-PR list is
empty. Its content is on `main`:
`git show origin/main:examples/support-copilot/app/generated/agents.py` contains
`RESUME_REFUSED`, and `git show origin/main:packages/ir/src/gates/resume.ts` contains
`const [first] = pausing;`.

There is only one branch, so the question is moot. The scope rule ("do not change the resume
implementation") still holds and is honoured. This is recorded in §4.

### 1.5 What `release-plan` computes for four kinds of pull request — PASS, two cases untested

The job (`ci.yml:493-571`) archives `origin/$BASE_REF`, runs the *current*
`scripts/version.mjs declared` against that tree to learn the version the branch declares,
builds `tags.txt`, runs `decide`, then runs `verify --version`.

Reading the version from the base branch's manifests rather than from the tag list is
deliberate and documented at `scripts/version.mjs:387-401`: `release.yml` mints the tag only
after CI on `main` passes, so for a minute or two the newest tag lags the manifests, and a
tag-derived plan failed correctly stamped pull requests. That was the Round 8 fix (#220).

| Case | What the job computes | Tested today |
| --- | --- | --- |
| Single releasable PR | base declares `0.1.178`; changed paths hit a releasable prefix → plan `0.1.179`; `verify` requires every manifest to declare `0.1.179` | **Partly.** `decide` and `verify` are unit-tested separately (`version.test.mjs:96-210`, `:663-806`); the job's `declared → decide --tags → verify` composition is not |
| Two stacked PRs merged back to back | PR1 plans `0.1.179` and is stamped so. After the merge the base declares `0.1.179`, but PR2 was stamped `0.1.179` too, so the job plans `0.1.180` and `verify` fails on every manifest — correct, and it demands a re-stamp | **No.** Nothing simulates a base that advanced past the pull request's own stamp. This is the stacking failure mode and it is the one a contributor will hit |
| PR whose base has an unreleased merge | base manifests declare `0.1.179` while the newest tag is still `0.1.178`; the job reads the manifests and plans `0.1.180` | **Partly.** `declared` is unit-tested (`version.test.mjs:808-915`); the job reading the archived base tree rather than `git tag` is shell and untested |
| Docs-only PR | every changed path matches `nonReleasable` (`^docs/`), so `decide` returns no release; nothing to stamp | **Unit-tested** in path-based gating; the job's no-release branch is untested |

The unit tests are good; the untested surface is the job's composition — `git archive` of an
unreleased base, the `git tag --list` fallback, and stacked pull requests.

### 1.6 The two code-scanning alerts — #117 fixed, #116 open, the rule right in both cases and 0008's reasoning mis-scoped for #116

```text
gh api .../code-scanning/alerts/116 → state=open  rule=py/ineffectual-statement
                                      path=runtimes/python/src/aid_runtime/evals/metrics.py:109
gh api .../code-scanning/alerts/117 → state=fixed rule=py/ineffectual-statement
                                      path=runtimes/python/src/aid_runtime/evals/metrics.py:107
gh api .../code-scanning/alerts/119 → state=fixed ...agents/resume.py:103
```

RFC 0008 §1.15 classified all three as false positives and Phase E fixed three sites by
deleting `...` after reasoning that "the docstring *is* the body". That reasoning holds for
`Metric.name`, `Metric.deterministic` and `NonceStore.claim`, which all carry docstrings. It
does **not** hold for #116:

```python
107:    async def score(
108:        self, case: EvalCase, prediction: str, *, context: RunContext | None = None
109:    ) -> MetricResult: ...
```

`Metric.score` has no docstring, so `...` is its body and deleting it is a syntax error. The
alert is open because the site was correctly excluded from the fix that closed the other three,
but nobody then fixed *this* one. **#116 is a loose end from Round 8, not a new finding.**

Verdict: the rule fires correctly. The `...` is not a defect — it is a required stub body — but
the site is inconsistent with its two siblings, which are documented. The fix is to give
`score` the docstring it should have had and drop the `...`, matching Phase E's shape. One
line added, one removed.

### 1.7 Other constructs that are valid syntax and fail at runtime — the class is `F821`, and the check already exists and never runs

The Round 8 defect was a module-level name used but never bound (`RESUME_REFUSED`), emitted
because a bare expression sat where an assignment belonged. The static rule that catches this
is pyflakes `F821` (undefined name).

Three facts, all measured:

**The rule is enabled.** Both examples select it, and neither suppresses it for generated
code. `examples/support-copilot/pyproject.toml`:

```toml
"app/generated/**" = ["TID252", "T201", "ANN001", "ANN201"]
```

`examples/guarded-reply/pyproject.toml` carries the same selection. `runtimes/python/pyproject.toml`
selects `"F"  # pyflakes` too.

**The rule catches the exact defect.** On a copy with the `RESUME_REFUSED` assignment deleted:

```text
$ ruff check --config examples/support-copilot/pyproject.toml exact_bug.py
F821 Undefined name `RESUME_REFUSED`
   --> exact_bug.py:327:53
327 |         raise HTTPException(status_code=403, detail=RESUME_REFUSED) from refusal
    |                                                     ^^^^^^^^^^^^^^
Found 1 error.
```

**The check never runs on these files.** `python:ruff` is
`argv: ['python','-m','ruff','check','.']` with `cwd: 'runtimes/python'` (`check-all.mjs:178-184`).
The same is true of `python:mypy` (`:192-198`). Generated example code is therefore never
linted. That is the entirety of why CI missed the defect.

Both examples are clean under their own configuration today, and the cost of running them is
small:

| Target | ruff | mypy (strict) |
| --- | --- | --- |
| `examples/support-copilot` | 0.37 s, all checks passed | 9.95 s, 52 files, no issues |
| `examples/guarded-reply` | 0.18 s, all checks passed | 8.26 s, 26 files, no issues |

`F821` is not the only rule in the selection that would help — `B` (bugbear), `RET`, `SIM` and
`ANN` all apply to emitted code — but it is the one that would have caught this round's
predecessor.

## 2. Findings register

| # | Finding | Severity | Phase |
| --- | --- | --- | --- |
| 1 | `python:ruff` and `python:mypy` run only in `runtimes/python`, so generated example code is never linted, even though both examples configure the rules that catch the Round 8 defect | **high** — this is the actual cause | A |
| 2 | `e2e` never exercises a refusal; it resumes once with a valid checkpoint and stops | medium | B |
| 3 | #116 (`Metric.score`) is open; 0008's "docstring is the body" argument does not apply to it | low | C |
| 4 | Two of the four `release-plan` cases (stacked pull requests, unreleased base) are untested at the job level | medium | C |
| 5 | A template tree is not bootable: no `pyproject.toml`, no `app/main.py` | informational — bounds what a smoke job proves | D |
| 6 | `check-docs-claims` counts an example's files with `PRUNED`, which prunes `__pycache__` and `.pytest_cache` but not `.mypy_cache` or `.ruff_cache` (`:220`), while its source walk uses `SOURCE_PRUNED`, which does (`:223-230`). A single file under `examples/support-copilot/.mypy_cache` makes the count 68 against the documented 67 and fails the check. Nothing in today's `pnpm check` creates that directory, because `python:mypy` runs with `cwd: runtimes/python`. **Phase A creates exactly that directory** by linting with `cwd: examples/support-copilot`, and `lint:md` (`check-all.mjs:146`) runs before `python:mypy` (`:193`), so Phase A would pass once and fail on every run after | **must be fixed in Phase A**, or Phase A self-breaks | A |
| 7 | The brief says #221 is open and untouchable; it merged before the round began | must be reported | §4 |

## 3. Phase order, revised

The brief orders A (smoke tests) then B (resume review-as-tests) then C then D. Phase 0
changes that: the smallest increment that prevents the Round 8 class is not a smoke job, it is
pointing two existing linters at two existing directories. It is three lines of configuration
and 0.55 s, and it catches the defect statically at the exact line, before a server is started.

Revised order, smallest and highest value first:

- **Phase A — lint the generated trees.** Add `ruff` and `mypy` steps at each example's own
  configuration to `check-all.mjs`, and add `.mypy_cache` and `.ruff_cache` to `PRUNED` in
  `scripts/check-docs-claims.mjs` so the file-count claim survives the new cache directories
  (finding 6 — without it Phase A passes once and then fails on every subsequent run).
  Acceptance: deleting the `RESUME_REFUSED` assignment fails `pnpm check` with `F821`, and two
  consecutive `pnpm check` runs both pass. Effort: ~0.55 s ruff, ~18 s mypy, two files changed.
- **Phase B — extend `e2e` to the refusal path.** Three assertions against the already-running
  server: a tampered checkpoint is refused with 403 and an opaque body; a second resume of a
  spent checkpoint is refused with 403 and the same body; the two bodies are byte-identical, so
  the refusal is not an oracle. No new harness. Acceptance: a deliberately broken refusal path
  fails `pnpm e2e`.
- **Phase C — `release-plan` composition tests, and #116.** Table-driven tests for the two
  untested cases in §1.5 plus the no-release branch; then the one-line fix for #116.
- **Phase D — review-as-tests for the checkpoint.** Narrowed by Phase 0: the seven properties
  the brief lists are largely covered already (see §3.1), so this phase adds only what is
  genuinely missing.
- **Phase E — docs and the process rule.** A "what the smoke job proves, and what it does not"
  paragraph in `docs/guide/boundary.md`, the template-bootstrap limitation from §1.2, and the
  status-claim rule in `CONTRIBUTING.md` (this repository has no `AGENTS.md`).

### 3.1 Why Phase D is smaller than the brief expects

The brief asks for review-as-tests of seven checkpoint properties. Thirty tests already exist
across `runtimes/python/tests/test_agents_resume_hardening.py` (18) and
`test_agents_checkpoint_integrity.py` (12), and they cover six of the seven:

| Property in the brief | Existing coverage |
| --- | --- |
| order (owner before nonce) | `test_the_owner_is_checked_before_the_nonce_is_claimed` |
| atomic single use | `test_the_same_checkpoint_is_spendable_once` — single process only |
| downgrade | `test_an_unsigned_checkpoint_is_refused_by_a_signed_app` |
| rotation | three tests, including a retired secret still verifying |
| owner binding | six tests |
| startup key check | `signer_from_env` refuses an unset or empty variable; the signer is built in `build_runtime` (`agents.py:211`), which the app calls at startup |
| overlay | **nothing** |

So Phase D adds: an overlay-supplied resume configuration test, a boot-time assertion that a
declared signing key that is absent fails startup rather than the first resume, and — if cheap
— a two-process single-use test. It does not re-test what is green.

## 4. Where the brief and the repository disagree

1. **#221 is merged.** The brief states it is open and forbids touching it. It merged at
   `2026-11-14T11:08:21Z` (merge commit `a70e933`); #222 followed; `main` is `c6ac24d`; no pull
   requests are open. Consequences: §1.4's branch-selection question is moot, the "pending
   #221" tagging has no referent, and tests written in this round run against `main`, where the
   code already lives. The scope rule against changing the resume implementation is honoured
   regardless.
2. **Generated apps are already booted** in three jobs (§1.1), which the brief does not
   anticipate.
3. **The linters that catch the defect are already configured**, just never invoked on
   generated code (§1.7).
4. **#116 is not a false positive in the sense 0008 recorded**; it is a fourth site to which
   0008's reasoning does not apply (§1.6).
5. **There is no `AGENTS.md`.** `CONTRIBUTING.md` is the agent-instruction file, and the
   status-claim rule belongs there.

## 5. Cost

| Change | Added CI time | New harness |
| --- | --- | --- |
| Phase A, ruff over both examples | ~0.6 s | none |
| Phase A, mypy over both examples | ~18 s | none |
| Phase B, three `e2e` assertions | ~0 (server already running) | none |
| Phase B, if a template boot job is added | ~1.2 s generate + install + boot | yes, and it tests harness-owned bootstrap |
| Phase C, tests + one-line fix | ~0 | none |
| Phase D, three tests | ~2 s | none |

Nothing here needs a nightly job; every phase fits in the pull-request job.

## 6. What this round does not do

- No spec change, no generator change, no new diagnostic, no version bump.
- No change to `packages/ir/src/gates/resume.ts`, `aid_runtime/agents/resume.py`,
  `state.py`, `policy.py`, `deep_agents.py` or `emit/agents.ts`, beyond the #116 docstring in
  `aid_runtime/evals/metrics.py`.
- No attempted fix for anything Phase D finds; findings become follow-ups for a human owner.
- No admin bypass on any pull request this round.
