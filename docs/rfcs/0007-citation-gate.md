# RFC 0007 — Round 7: the citation gate

| Field | Value |
| --- | --- |
| Status | **Draft — awaiting review.** Phase 0 only; no feature code written. |
| Phase | 0 (verify) |
| Affects | `scripts/docs-claims.mjs`, `scripts/check-docs-claims.mjs`, `scripts/check-all.mjs`, `packages/*/src/diagnostics.ts` (metadata only), `site/scripts/gen-reference.mjs`, `docs/guide/boundary.md`, `docs/reference/{spec,eval-metrics}.md`, `docs/guide/delivery.md`, `docs/migration.md` |
| Continues | [RFC 0001](./0001-agents-at-scale.md), [0002](./0002-agents-at-scale-round-2.md), [0003](./0003-round-3-agent-evals.md), [0004](./0004-round-4-resume-and-agent-loop.md), [0005](./0005-round-5-site-and-hygiene.md), [0006](./0006-round-6-capability-truth.md) |
| Verified against | `origin/main` at `0b86cd5`, release `0.1.170`, spec `0.33`; this branch at `1a7dc43`, release `0.1.171`; live site fetched with a cache-buster |

> **Nothing proposed here is built.** Every claim about current behaviour cites the file and
> line that proves it, or the command that produced it. Numbers come from the four scripts in
> §7, not from memory — which is the point of the round.

---

## 0. Summary

Round 5's boundary page cited five diagnostic codes that do not exist, and `check-docs-claims`
could not notice: it compares claim counts and relative links, never a code against its
registry. This round makes docs cite facts from their source.

Phase 0 found more than the brief assumed:

- **529 code-shaped citations** across 51 pages; **98 of 292** registered codes are cited at all.
- **12 unknown code tokens**, of which **3 sit on published pages** and a fourth — the one in
  `spec.md` — describes a gate that does not exist *and* a behaviour that is not generated.
- **Severity and condition cannot be generated** from the registries today: they hold bare code
  strings, and **160 of 292** codes have no mechanically discoverable severity.
- Two of the four Phase C categories (`env` vars, refused target names) produce mostly false
  positives without the annotation mechanism Phase A introduces, and one of them has no
  registry to check against at all.

## 1. Where this round departs from the request

Reported, not silently resolved:

1. **RFC number 0006 is taken.** `docs/rfcs/0006-round-6-capability-truth.md` exists on this
   branch (unmerged PR #211, `1a7dc43`). `origin/main` holds 0001–0005 only. This file is
   therefore **0007**, and the Phase D brief becomes `0007-appendix-resume-review.md`.
2. **PR #211 is open, not merged, and its `node` CI job failed** while every other job passed.
   Round 6's work is not in `main`, which is why the live site (0.1.170) trails this branch
   (0.1.171). This round's docs work will land on top of an unmerged branch unless #211 lands
   first; flagged for the reviewer to sequence.
3. **Four bad citations already sit on published pages.** Phase A's acceptance criterion
   ("reintroducing `ir/eval-coverage` fails CI") is unreachable until they are fixed or
   annotated, so Phase A must carry those four edits. That is a scope addition to the request.
4. **Phase D's file name** in the request (`0006-appendix-resume-review.md`) collides for the
   same reason as item 1.
5. The brief's premise that a *naive* code check would be safe is wrong in three specific ways
   found below (retired codes in migration notes, file paths that look like codes, prose that
   names a refused cloud). The annotation mechanism is not an optional nicety; it is load-bearing.

## 2. Phase 0, item by item

### 2.1 Site freshness — PASS

Cache-busted fetch (`?cb=<guid>`, `Cache-Control: no-cache`): 57,877 bytes, version token
`0.1.170`. `origin/main` is `0b86cd5` with `packages/cli/package.json` at `0.1.170`. This branch
is `1a7dc43` at `0.1.171`.

The live homepage carries every Round 5 fix: the overlay example's "continued" fragment defines
`agents.triage_agent` and `models.triage`, so the abridged example no longer cites paths the
earlier fragment does not define; `specVersion: "0.33"`; a Delivery link and a Boundary link
under "Where to go next"; and a "What AID is not" section with explicit "Not your identity
provider" and "Not a durable run store" bullets.

Site equals `main`. The only difference from this branch is the unmerged PR — no deploy-trigger
defect, no CDN staleness, no post-deploy assertion against the wrong URL.

### 2.2 Inventory — PASS, with one category that has no source of truth

Scope is the one `check-docs-claims` already uses (51 pages: `README.md`, `docs/**`,
`examples/**`), counted by `files/inventory-citations.mjs`.

| Kind | Source of truth | Citations | Distinct |
| --- | --- | --- | --- |
| Diagnostic codes | the five `*DIAGNOSTIC_CODES` literals | 529 | 110 codes + 4 wildcards |
| CLI commands | CLI command table (`packages/cli/src/main.ts`) | 554 | 18 |
| CLI flags | per-command option definitions | 239 | 34 |
| Spec field paths (backticked, dotted) | `packages/spec/src/schema/spec.schema.json` | 128 | 54 |
| Profile names | schema enum (`standard`, `enterprise`) | 141 | 2 |
| Target names | schema enum (`py-fastapi`, `ts-vercel`) | 131 | 2 |
| Environment variables | **none exists** | 153 raw | 81 raw |
| File paths | the tree | 292 | 162 |

Three notes that change the plan:

- **The env-var row is not a number yet.** A loose uppercase-token rule counts 153 "citations",
  most of which are constants in backticks (`STREAMING`, `NOTICE`, `DEGRADED`). A real rule needs
  a namespace prefix. And the "runtime's declared list" the request assumes does not exist as an
  artifact: env vars are read across `runtimes/python`, `packages/cli/src/commands/*`,
  `packages/generator-sdk/src/scaffold.ts` and `packages/ir/src/gates/*`, with 11 discoverable in
  runtime source alone and the rest emitted inside generator template strings. See C.4.
- **CLI commands and flags are cheap and high value**: 18 and 34 distinct names respectively,
  already extracted by existing detectors, both with registries to check against.
- **Refused-cloud prose is legitimate**: 6 of the target-token matches are `azure`/`kubernetes`,
  which docs name *in order to explain the refusal*. A naive name check fails honest
  documentation.

### 2.3 Code extraction — PASS

Registry parse (`files/reverse-report.mjs`): **292 codes** — `ir` 101, `cli` 116, `spec` 42,
`overlay` 9, `generator` 24. Cited: **529 sites**, **110 distinct codes** plus **4 wildcards**;
by namespace `ir` 404, `cli` 64, `overlay` 38, `spec` 23, `generator` **0**.

Unknown tokens, with verdict:

| Token | Sites | Verdict |
| --- | --- | --- |
| `ir/eval-coverage` | `docs/guide/delivery.md:332`, `docs/reference/eval-metrics.md:124`, 5 RFC pages | **Published defect.** Registered code is `ir/eval-uncovered` |
| `ir/network-target` | `docs/reference/spec.md:774` | **Published defect.** Registered nowhere; no gate emits it — see 2.5 |
| `cli/trace-export-redaction-unapplied` | `docs/migration.md:709`, `:726` | Deliberate: a retired code in a "Before" column. Needs annotation, not deletion |
| `ir/eval-agent-coverage`, `ir/eval-trajectory-coverage`, `ir/cost-fallback-profile`, `ir/eval-metric-unmeasured`, `ir/alerts-percentile`, `ir/resume-secret-inline`, `ir/eval-metrics`, `ir/model-retired` | `docs/rfcs/0001`, `0002`, `0004`, `0006` | Proposal prose. `docs/rfcs/` is excluded from the site and already exempt in `docs-claims.mjs` via `isProposalPage`; the gate must preserve that |
| `ir/src` | `docs/rfcs/0002-agent...md:53`, `:208` | **False positive.** The text is the file path `ir/src/gates/promotion.ts:134` |

Wildcards: `ir/policy-*` (`docs/guide/boundary.md:65`, published, plus RFC 0005),
`cli/eval-compare-*`, `ir/profile-*` (RFC 0001), `ir/alerts-*` (RFC 0005). A wildcard is a
family reference, not a citation; the gate should require an allow-listed marker and verify the
family resolves to at least one registered code.

Reverse report: **98 of 292 codes are cited somewhere; 194 are cited nowhere** — `generator` 0 of
24, `cli` 88 of 116 uncited, `ir` 42 of 101, `spec` 37 of 42, `overlay` 3 of 9. The whole
`generator/*` namespace is undocumented, which is worth seeing but must not fail the build.

### 2.4 Registry metadata — FAIL: insufficient for Phase B today

The five registries hold **code strings only** — no severity, field path, condition or hint. A
diagnostic's severity is decided at its emission site, and frequently through a local closure
that takes the code as an argument. `packages/spec/src/overlay.ts:286` is the clearest example:
the code is passed into a local `report(message, path, hint)` that decides severity inside.

Text-window classification across all 292 (`files/derive-severity.mjs`): **124 error-only, 2
warning-only, 6 conditional, 160 undetermined**. The conditional six include
`ir/eval-uncovered` — emitted as a warning for `standard` and an error for `enterprise` from
spec `0.31` (`packages/ir/src/gates/eval-coverage.ts:52`, `:88`) — plus `ir/resume-unsigned`,
`ir/resume-replay-weak`, `ir/cost-profile-unknown`, `ir/prompt-variable-undeclared`,
`ir/prompt-variable-unused`.

So the boundary table's severity and condition columns **cannot** be generated from the registry
as it stands, and they cannot honestly be regenerated from call sites either: that would be an
AST analysis of plumbing that still could not express "an error under `enterprise` from `0.31`".
Phase B needs declared metadata; §4 proposes its shape.

### 2.5 Unbacked and overstated claims — FAIL

Found in `boundary.md` and `delivery.md`, and (new) on published reference pages:

1. **`docs/reference/spec.md:774` — the worst of them.** It says `private: true` "places the
   workload in private subnets with no public address and emits the egress path its declared
   dependencies need; a cloud with no private-placement module is refused
   (`ir/network-target`)". Both halves fail:
   - no such code exists, and no gate implements the refusal (greps over `packages/cli/src`,
     `packages/generators` and `packages/ir/src/gates` find no reader);
   - **nothing outside `packages/ir/src/gates/profile.ts` consumes `network.private`.** No infra
     module or generator reads it; the only other mention is prose in
     `packages/cli/src/templates.ts:470`. Placement comes from module inputs —
     `packages/cli/src/infra/modules/container.ts:220` is `create_network = var.vpc_id == ""` —
     so a container or CDK deployment gets a two-AZ VPC with private subnets whether or not the
     deployment declares `network`.
   This is the exact failure class the round exists to stop: a doc comment invented a code
   (`packages/ir/src/shapes.ts:1354`), a generated reference page copied it into the published
   site, and nothing compared either against reality.
2. **`docs/reference/eval-metrics.md:121-124`, published.** Cites `ir/eval-coverage`, and calls
   the two coverage signals "warnings, not failures". Both sites emit `ir/eval-uncovered`
   (`packages/ir/src/gates/eval-coverage.ts:43-52`, `:79-88`) and both **escalate to an error**
   for `enterprise` from spec `0.31`. Wrong name and inverted severity in one sentence.
3. **`docs/guide/delivery.md:332`, published.** Cites `ir/eval-coverage`; the severity
   description in the same cell is correct.
4. **`docs/migration.md:709`, `:726`, published.** Cites a retired code on purpose. Correct as
   written; a naive gate would fail it.
5. **`docs/guide/boundary.md:39`** — "Every `ir/*` diagnostic above is emitted by `aid validate`"
   — **TRUE**, and worth keeping as a check: every code in that table lives in `packages/ir`,
   and `aid validate` lowers the spec through `lowerSpec` (`packages/cli/src/commands/validate.ts:2`,
   `:23`), which runs the gate pipeline.
6. **`docs/guide/boundary.md:29`** — "`ir/policy-syntax` … with nine siblings" — **TRUE**: there
   are 10 `ir/policy-*` codes. This is the kind of count the gate should derive rather than
   trust.
7. **`docs/guide/boundary.md:65`, published** — `ir/policy-*` is a family, not a code.
8. `docs/guide/delivery.md:333-334` uses "Gated only" as a maturity label for identity and
   durable state. That matches Round 4/5's honest wording and is hand-written prose; not
   changed here, but it is not checkable and should stay in the reviewed column.

Minor, not a defect: `ir/eval-trajectory` is emitted from
`packages/ir/src/gates/observability.ts`, not from an eval gate. The boundary table's trajectory
row does not misdescribe it.

## 3. What changes, in order

### Phase A — diagnostic-code gate (ships first, smallest)

One detector, one comparison, one annotation rule, one reverse report.

- `scripts/docs-claims.mjs` — add `diagnosticCodes(text)` returning `{ token, line, wildcard }`
  for namespaces `ir|spec|cli|overlay|gen`. Two guards the inventory proved necessary: reject a
  token that continues into a path (`ir/src/…` — require the next character not to be `/` and the
  token not to be preceded by one), and reject a token that is part of a link target.
- `scripts/check-docs-claims.mjs` — resolve each token against the five registries; fail on an
  unknown token and on an unannotated wildcard; print file, line, token and the nearest
  registered codes by edit distance.
- Annotation syntax, deliberately narrow: a line-level marker naming the reason, used for
  `docs/migration.md`'s Before columns. `docs/rfcs/**` keeps its existing `isProposalPage`
  exemption.
- Reverse report, non-failing: registered codes cited nowhere (§2.3), grouped by namespace.
- Fixes in the same PR, because the gate cannot pass without them: `delivery.md:332`,
  `eval-metrics.md:121-124` (code and severity), `spec.md:774` (see the decision below),
  `migration.md:709/726` (annotate).
- Fixtures: an invented code, a wrong-namespace code, a wildcard, and the `ir/src/gates/…` path
  false positive must each fail; a well-formed page must pass.
- Wire into `check-all.mjs` so `pnpm check` and CI run it over the whole tree.

**Acceptance:** reintroducing `ir/eval-coverage` into any docs page fails CI; `ir/src/gates/...`
does not.

**Decision needed — `spec.md:774`.** Two honest options: (a) rewrite the sentence to state what
is true today — the profile gate requires the declaration, and private placement is emitted by
the container and CDK modules from their own inputs, not from the flag — and open a follow-up to
decide whether `network.private` should ever change emitted infra; or (b) keep the promise and
implement `ir/network-target`. This round recommends **(a)**, because (b) is a product change and
the brief is explicit that this round ships no product features. Either way the phantom code goes.

### Phase B — generate the boundary table's factual columns

Depends on new metadata, so it does not ship before A:

- Add per-code `severity` and a one-line `condition` to the registries, with an explicit shape for
  the six conditional codes (severity plus the profile/version at which it escalates). A test
  asserts every code has both.
- Generate the concern/code/severity/condition cells of `docs/guide/boundary.md` from the
  registry; keep "What you provide" and "Residual risk" hand-written in a source file whose row
  keys must match the registered concern list — a missing or orphaned key fails the build.
- `gen-reference --check` fails on a stale page.

**Acceptance:** changing a diagnostic's severity in code changes the page on regeneration, and a
stale page fails.

### Phase C — the other memory-cited facts, in value order

1. **CLI commands and flags.** Detectors exist, registries exist, 554 and 239 citations. Highest
   value per unit of work.
2. **Spec field paths.** 128 citations, 54 distinct. A shallow check against the schema found no
   unknowns, so the risk here is low and the work is mostly keyed-map awareness
   (`agents.<name>`) and placeholder allowance.
3. **Profile and target names.** 141 and 131 citations. Works, but needs A's annotation so prose
   about `azure` and `kubernetes` can name a refused target.
4. **Environment variables.** **No registry exists.** Per the brief's own instruction this is
   reported, not built: the prerequisite is a declared list of env vars the runtime and generated
   app read, emitted as data, before any doc check can compare against it.

### Phase D — the signed-resume review brief

`docs/rfcs/0007-appendix-resume-review.md`: the checklist from the brief, each item marked
PASS/FAIL/UNCLEAR against the current code with a pointer, and findings listed as follow-ups
rather than fixed.

## 4. Proposed registry metadata (Phase B shape)

```ts
// Illustration only — Phase B decides the exact shape.
const IR_DIAGNOSTIC_CODES = {
  evalUncovered: {
    code: 'ir/eval-uncovered',
    condition: 'an HTTP pipeline with no gate.ci eval claiming it',
    severity: 'warning',
    escalates: { profile: 'enterprise', since: '0.31' },
  },
  // …
} as const
```

The existing bare-string form is used by ~500 call sites, so Phase B must keep
`IR_DIAGNOSTIC_CODES.foo.code`-style access mechanical or derive the strings from the objects at
module load. This is the one place where the round touches package source, and it changes no
behaviour; if the migration proves noisy, Phase B may instead add a sibling
`DIAGNOSTIC_METADATA` map keyed by code string. The RFC will record which was chosen.

## 5. Smallest first increment

Phase A as described, with the four page fixes and four fixtures: one detector, one comparison
loop, one annotation rule, one non-failing reverse report, wired into `pnpm check`.

## 6. Risks

- A name gate proves a code exists, not that the sentence around it is true.
  `eval-metrics.md:121-124` would still have passed Phase A's *name* test had the code been
  right while the severity was inverted. Phase A catches names; Phase B/C catch derivable facts;
  prose stays hand-written and reviewed. This RFC does not claim more.
- The annotation syntax is an escape hatch. Keep it line-scoped and require a reason, or it will
  become the place bad citations hide.
- Phase B's metadata migration touches files that ~500 call sites depend on; if it is noisier
  than expected, the sibling-map fallback in §4 keeps the blast radius at one module.

## 7. How these numbers were produced

Session artifacts, not committed: `files/extract-codes.mjs` (citations),
`files/reverse-report.mjs` (registry diff and reverse report), `files/inventory-citations.mjs`
(per-kind counts), `files/derive-severity.mjs` (severity derivability). Each runs as
`node <script> <repo-root>` and reads the registries and pages directly; none of the figures in
this RFC is hand-counted.

## 8. Phase A: what shipped

`diagnosticCodes` and `codeAnnotation` in `scripts/docs-claims.mjs`; `checkDiagnosticCodes`,
`registeredDiagnosticCodes` and `reportUncitedDiagnostics` in `scripts/check-docs-claims.mjs`. The
check runs from `lint:md`, so `pnpm check` and CI carry it with no workflow change.

**The rule.** Every token in the five registered namespaces resolves exactly to a registered code.
A wildcard must be marked `<!-- docs-claims: family; why -->` and must match at least one registered
code. A token that does not resolve must be marked `<!-- docs-claims: retired; why -->`. Both
markers are line-scoped HTML comments with a reason of at least twelve characters: invisible on the
published page, unavoidable in review. A marker naming the wrong kind is itself a failure, so
`family` cannot be used to wave through an invented code. `docs/rfcs/` keeps the proposal exemption
the other checks already rely on, because naming a gate you are proposing is the job of an RFC.

The registries are parsed from source rather than imported, so the check runs before anything is
built and a registry that stops parsing fails instead of shrinking the legal set. Each of the five
namespaces must contribute at least one code for the same reason.

**The plan said four page fixes. The check found six sites**, because one retired code appears
twice and one of the six is a generated row rather than a page:

| Site | Was | Now |
| --- | --- | --- |
| `docs/guide/delivery.md:332` | `ir/eval-coverage`, "a warning below spec `0.31`" | `ir/eval-uncovered`, "a warning under `profile: standard`, a refusal for `enterprise` from spec `0.31`" |
| `docs/reference/eval-metrics.md:121` | `ir/eval-coverage`, "both are warnings, not failures" | `ir/eval-uncovered`, and the `enterprise` escalation stated |
| `docs/migration.md:709`, `:726` | `cli/trace-export-redaction-unapplied`, a retired code in a Before column | text unchanged, line marked `retired` |
| `docs/guide/boundary.md:65` | `ir/policy-*` | text unchanged, line marked `family` |
| `docs/reference/spec.md:774` | `ir/network-target`, which nothing registers | the row rewritten to what the code does |

The last one is a source edit, not a prose edit: the row is generated from the `network`
description in `packages/spec/src/schema/spec.schema.json`, so the description was corrected and
`gen-reference.mjs` rerun. The `DeploymentNetworkShape` docstring in `packages/ir/src/shapes.ts`
carried the same phantom code and was corrected with it — and while confirming the claim, the
docstring's premise turned out to be false twice over: nothing refuses a cloud for lacking private
placement, and no generator branches on the key at all, so the corrected text says the pin states a
requirement rather than selecting a module. That is a Phase 0 item-5 finding the name test could
never have produced, and it is recorded here rather than fixed: `docs/guide/delivery.md`'s private
network row still claims "Gated and generated" for a key no emitter reads. Follow-up, not this PR.

Observed after the fixes: 519 diagnostic-code citations resolve in the documents `markdownFiles()`
returns, and 192 of the 292 registered codes are cited in no document (`cli` 88, `generator` 23,
`ir` 42, `overlay` 3, `spec` 36). The reverse report prints those counts on every run and the names
with `--uncited`, so an undocumentable diagnostic is visible without being a failure.

**What this does not prove.** A name check proves the code exists and nothing about the sentence
around it. `eval-metrics.md` had the right code in spirit and the wrong severity: it described two
warnings that escalate to refusals. Phase A would have passed that page had the name been spelled
correctly. Severity is Phase B's job, and it needs registry metadata that does not exist yet.
