# RFC 0005 — Round 5: the site, the local gate and the boundary page

| Field | Value |
| --- | --- |
| Status | **Draft — awaiting review.** No feature code written. |
| Phase | 0 (verify only) |
| Affects | `.github/workflows/docs.yml`, `package.json` scripts, `lefthook.yml`, `CONTRIBUTING.md`, `packages/spec` (cloud pattern), `packages/ir` (cloud gate), `packages/cli` (`paths.ts`), `docs/guide/boundary.md` (new), `docs/index.md` |
| Continues | [RFC 0001](./0001-agents-at-scale.md), [RFC 0002](./0002-agents-at-scale-round-2.md), [RFC 0003](./0003-round-3-agent-evals.md), [RFC 0004](./0004-round-4-resume-and-agent-loop.md) |
| Verified against | `origin/main` at `ed62049`, release `0.1.168`, spec `0.33`, live site fetched 2026-11-13T18:47Z |

> **Nothing proposed here is built.** Every claim about current behaviour cites the file and
> line that proves it, or quotes the command that produced it. The round-5 brief asserted a
> live-site defect that this round could not reproduce; it is marked **UNCLEAR** rather than
> "fixed" and the premise is not acted on as if it were true.

---

## 0. Summary

| # | Check | Verdict |
| --- | --- | --- |
| 1 | Homepage on `main` is the corrected version | **PASS** — all five defects are fixed on `main`, and the example validates and resolves as published; see §1 |
| 2 | The Pages deploy path | **PASS (mechanism)** / **UNCLEAR (premise)** — every merge to `main` since `decc596` deployed successfully, the last one at 17:05Z; the live site is `0.1.168`, not `0.1.162`; see §2 |
| 3 | Cache, CDN and a post-deploy assertion | **FAIL (gap)** — no post-deploy check exists anywhere; the CDN serves `max-age=600`; see §3 |
| 4 | Capitalised cloud names reach `ir/cloud-unsupported` | **FAIL** — `Azure`, `AZURE`, `Kubernetes` all fall to `spec/schema-violation` with no hint; see §4 |
| 5 | A contributor can reproduce CI locally | **FAIL** — `pnpm check` omits the docs gates, `lint:actions`, `lint:licenses`, e2e and the Python runtime, and `lefthook.yml` claims it does not; see §5 |
| 6 | Enforcement vs responsibility is documented in one place | **FAIL (scattered)** — the enterprise checklist is the best page but covers 10 controls and no reviewer table; see §6 |

One defect outside the brief, found while verifying item 1: **`aid resolve` with a Windows
path separator looks for the base in the wrong directory** (§7).

---

## 1. The homepage on `main` (item 1) — PASS

`git diff --stat origin/main HEAD` is empty, so the working tree under test is `origin/main`
(`ed62049`). `docs/index.md` carries the corrected copy for every defect the brief lists:

| Defect named in the brief | State on `main` | Evidence |
| --- | --- | --- |
| Overlay example labelled "abridged", naming paths the base does not define | **Fixed** — the word does not appear; the base fragment now defines both paths the overlay moves | The string `abridged` has no match in `docs/index.md`. `models.fast` is defined at `docs/index.md:49-54`, `agents.triage_agent` at `:103-108`; the overridable paths at `:117-123` name `deployments.api.region`, `models.fast.modelId` and `agents.triage_agent.maxCostBudget`, and the overlay at `:128-135` moves exactly those three |
| `specVersion: "0.2"` | **Fixed** | `docs/index.md:40` reads `specVersion: "0.33"` |
| No Delivery playbook link in "Where to go next" | **Fixed** | `docs/index.md:283` — "Taking it to a customer? The delivery playbook (`guide/delivery.md`) …" |
| "Declared identity" in "Built for" | **Fixed** — replaced by wording that names the spec field | The string `Declared identity` has no match. `docs/index.md:158-162` says the identity block's `verifiedBy` "names the entry point that verifies the token" |
| No auth / durable-state bullet under "What AID is not" | **Fixed** — both bullets exist | `docs/index.md:252-257` "Not your identity provider. No token verification is generated…"; `:258-262` "Not a durable run store…" |

The example is not merely present, it is true. Extracting the three YAML fences from
`docs/index.md`, concatenating the first two into `app/app.spec.yaml` and writing the third to
`customers/acme-eu.yaml`:

```text
$ aid validate app/app.spec.yaml
app/app.spec.yaml: ok (0 errors, 0 warnings)

$ aid resolve customers/acme-eu.yaml --out customers/acme-eu.spec.yaml
wrote customers/acme-eu.spec.yaml (3 overrides applied)

$ aid fleet
1 customer under .

  customer  profile   models        region          ceiling  status
  acme-eu   standard  gpt-4.1-mini  ap-southeast-2  $1.50    ok
```

That is the same table the homepage prints at `docs/index.md:144-148`, including the `$1.50`
ceiling and the `ok` status. **A regression here is possible and currently untested** — nothing
reads `docs/index.md`'s fences and compiles them, so the "abridged" defect of round 3 could
return without a red build. See §8, Phase A.

## 2. The Pages deploy path (item 2)

**What triggers a deploy.** `.github/workflows/docs.yml` runs on three events
(`docs.yml:16-20`): `pull_request` to `main`, `push` to `main`, and `workflow_dispatch`. The
configure, upload and deploy steps are gated on `if: github.event_name != 'pull_request'`
(`docs.yml:101`, `:105`, `:112`), so a pull request builds and checks the site but publishes
nothing. **A merge to `main` is the only automatic publisher.**

**What the `deploy` job does.** It needs the `build` job, takes `pages: write` and `id-token:
write`, and calls `actions/deploy-pages@v5` (`docs.yml:110-127`). The `build` job uploads
`site/.vitepress/dist` as the Pages artifact after running, in order: `docs:check` →
`docs:build` → `docs:head` → `docs:links` → `docs:a11y` → `docs:browser` (`docs.yml:60-99`).
So a broken page, dead link, stale generated reference or accessibility regression fails
before anything is published.

**Why `deploy` and `stamp` were "skipping" in the Phase F run.** Neither is a skipped check in
the sense of a disabled gate:

- `deploy` is the second job of `docs.yml`, and `if: github.event_name != 'pull_request'`
  (`docs.yml:112`) is exactly why it does not run on a PR. On the merged `ed62049` push it ran
  and succeeded.
- `stamp` belongs to `.github/workflows/dependabot-stamp.yml` (`:27-28`), which is restricted to
  Dependabot pull requests (`dependabot-stamp.yml:30`). A human PR never runs it.

**The deploys that actually happened.** `gh run list --workflow docs.yml` and the Pages
deployments API agree:

| Commit | Merged into `main` | Docs run | Deploy job | Pages deployment |
| --- | --- | --- | --- | --- |
| `decc596` (Phase B) | 15:23Z | success | success | 7769003047, 15:23:35Z |
| `539ded0` (Phase C) | 15:49Z | success | success | 7769603541, 15:49:21Z |
| `1584055` (Phase D) | 16:23Z | success | success | 7770411792, 16:23:13Z |
| `8f5ebcc` (Phase E) | 16:46Z | success | success | 7770959805, 16:46:50Z |
| `ed62049` (Phase F) | 17:05Z | success | success | 7771383008, 17:05:33Z |

**Why the site does not show `0.1.162`.** It does not — the live homepage serves `0.1.168` and
carries none of the five defects. Fetched at 18:47Z:

```text
$ curl -s https://aid-framework.github.io/aid-framework/ | grep -o '0\.1\.[0-9]*' | sort -u
0.1.168

Declared identity : False      abridged : False      specVersion: "0.2" : False
delivery playbook : True       durable run store : True
```

The same is true of `/aid-framework` (no trailing slash) and `/index.html`, at `Age: 84` and
`Age: 0` respectively, so this is not one warm cache entry. **The round-5 premise is
UNCLEAR**: either the observation was made before the 15:23Z deploy, or it was a browser cache
(the CDN sets `max-age=600`, §3). I could not reproduce a stale site, and I will not "fix" a
defect I cannot see by rewriting correct copy. What I can prove is that **nothing would have
told us** if a deploy had failed or served a stale version — that gap is real and is §3.

## 3. Cache, CDN and the missing post-deploy assertion (item 3) — FAIL (gap)

Response headers for the live homepage:

```text
Cache-Control: max-age=600
Age: 11
ETag: "6af74366-e094"
X-Cache: HIT
Last-Modified: Fri, 13 Nov 2026 17:05:42 GMT
```

So GitHub Pages' CDN may serve any copy for up to ten minutes after a deploy, with no
`must-revalidate` and no `stale-while-revalidate`. That fully explains a reader seeing the
previous release shortly after a merge. It does **not** explain a site stuck at `0.1.162` for
hours, which is why §2 marks the premise UNCLEAR.

There is no service worker: nothing in `site/` or `docs/` mentions `serviceWorker`, `sw.js` or
workbox, and `https://aid-framework.github.io/aid-framework/sw.js` returns 404. The base path
is `/aid-framework/` (`site/.vitepress/config.mts:77`), applied consistently by the link
checker, so no page is served from the wrong root.

**No post-deploy assertion exists.** Nothing in `.github/`, `scripts/` or `site/` fetches the
live host — every hit on `aid-framework.github.io` in the tree is a constant used to validate
generated HTML (`site/.vitepress/config.mts:4`, `site/scripts/check-a11y.mjs:40`, a comment in
`site/scripts/check-links.mjs:12`). The nearest thing is `site/scripts/site-version.test.mjs`,
which asserts that `{{ AID_VERSION }}` is substituted from the manifests *in the local build*
(`:39-46`) — a unit test of the substitution, not of the deployed result.

So the failure mode is: a deploy can fail, or deploy a stale artifact, and the repository looks
green. The live site is the product surface for this project; that is worth one HTTP request.

## 4. Capitalised cloud names (item 4) — FAIL

`cloud` was widened in Phase F to `"type": "string", "pattern": "^[a-z][a-z0-9-]{1,30}$"`
(`packages/spec/src/schema/spec.schema.json`), and `buildSpecCloud` refuses a known-but-unserved
cloud by name (`packages/ir/src/build.ts`, `UNSERVED_CLOUDS` in `packages/ir/src/shapes.ts`).
The pattern is lower-case only, so a capitalised name never reaches that gate. Measured on a
copy of `examples/support-copilot` with one `cloud:` line injected:

| `cloud:` | Diagnostic | Hint |
| --- | --- | --- |
| `azure` | `ir/cloud-unsupported` — "declares cloud "azure", which AID does not provision; the supported clouds are aws, gcp" | the capability-matrix hint |
| `kubernetes` | `ir/cloud-unsupported` — same, naming `kubernetes` | the capability-matrix hint |
| `Azure` | **`spec/schema-violation`** — `670:5: error: does not match ^[a-z][a-z0-9-]{1,30}$` | **none** |
| `AZURE` | **`spec/schema-violation`** — same regex message | **none** |
| `Kubernetes` | **`spec/schema-violation`** — same regex message | **none** |
| `awz` | `ir/deploy-target-unknown` — "declares cloud "awz", which is not one of aws, gcp" | "name a supported cloud, or drop `cloud` …" |

The regression is the one Phase F set out to remove, reappearing at a different capitalisation:
`Azure` is the spelling a person actually types when they name the vendor, and it produces a
regular expression with no hint instead of the paragraph that explains the deferral. This is a
**FAIL** and §8 Phase C fixes it.

## 5. Local checks vs CI (item 5) — FAIL

`pnpm check` is `pnpm lint && pnpm typecheck && pnpm test` (`package.json`). CI's `node` job runs
`pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`, `pnpm typecheck`,
`pnpm test:coverage` (`ci.yml:48-62`). The delta, per job:

| CI job | Commands | In `pnpm check`? |
| --- | --- | --- |
| `node` | `build`, `lint` (code + md + config), `typecheck`, `test:coverage` | **partly** — `test` without coverage; `build` and `lint` are covered, since `check` runs `lint` |
| `workflows` | `actionlint`, `node scripts/check-workflows.mjs` (`ci.yml:387`, `lint:actions`) | **no** |
| `licenses` | `pnpm lint:licenses` (`ci.yml:567`) | **no** |
| `docs` (`docs.yml`) | `docs:check`, `docs:build`, `docs:head`, `docs:links`, `docs:a11y`, `docs:browser` (`docs.yml:60-99`) | **no** — not one of them |
| `e2e` | `pnpm generate:guarded` + `git diff --exit-code`, `pnpm e2e`, `pnpm e2e:ts`, the ts example's `vitest` (`ci.yml:263-354`) | **no** |
| `python` | `pytest`, `ruff check .`, `ruff format --check .`, `mypy` in `runtimes/python` (`ci.yml:140-149`) | **no** |
| `evals`, `guarded-reply` | `pytest` + ruff + mypy over the example apps (`ci.yml:193-284`) | **no** |
| `tofu`, `cdk`, `conformance`, `release-plan` | `tofu validate`, `cdk synth`, the conformance harness, the release planner (`ci.yml:403-623`) | **no** |

Two further holes, both of which I hit myself in round 4:

1. **`lefthook.yml:1` states "`pnpm check` reproduces the full CI check."** That is false per the
   table above, and it is the sentence a contributor reads before trusting the shortcut.
2. **The pre-commit hooks lint staged files only** (`markdownlint: {staged_files}`,
   `biome check --staged`), and in this environment lefthook cannot spawn at all
   (`errno -4094`), so every commit here used `--no-verify`. A staged-only lint also cannot see
   a repository-wide rule: round 4's `MD040` in `docs/migration.md` was caught by CI's 63-file
   run, not by anything local, because I ran markdownlint over the six changed docs instead of
   the tree.

`CONTRIBUTING.md:90-93` is honest about this ("`pnpm check` is the gate CI runs … but it is not
the whole of CI"), so the fix is to make the claim true rather than to soften it: one command
that runs what CI runs, in CI's order, over the whole tree.

**Which checks a contributor can currently skip locally:** every row except `node`'s. That
includes the docs gates that guard the published site and the Python runtime tests that guard
the other half of the product.

## 6. What is enforced vs what you provide (item 6) — FAIL (scattered)

The information exists, in four places, at four altitudes, with no single page a security
reviewer can read:

| Location | What it covers | What it does not |
| --- | --- | --- |
| `docs/guide/delivery.md:316-361` "The enterprise checklist" | 10 controls — profile, region, audit sink, redaction, output guardrail, private network, approvals, eval coverage, identity, durable state — each with the spec field, the refusal, and what exists today | no authorization, secrets, model/prompt pinning, eval/cost gates, deployment or rollback; no "residual risk if you provide nothing" column; framed as a delivery checklist, not a review artefact |
| `docs/features.md:503-515` | the same two hardest rows as Declared / Enforced / **Not yet generated** triads | does not cover the other eight concerns at all; duplicates delivery.md's wording |
| `docs/index.md:252-262` | prose for identity and durable state | the two concerns only |
| `docs/reference/spec.md`, `docs/reference/cli.md` | field-level truth, gate by gate | never assembles the fields into "here is the boundary of the product" |

I found **no contradiction** between these pages: delivery.md's "Gated only. **No token
verification is generated**" (`:342`) and features.md's "no generator verifies a token
(`identity.verifiedBy` names who does)" (`:515`) agree, and both agree with the registry
partition that keeps `identity` and `durable-state` out of the shipped count. The problem is
assembly and coverage, not accuracy — which is the cheapest kind to fix.

## 7. Defect outside the brief: the overlay base on Windows

While running item 1 I resolved the homepage overlay with a Windows path separator and got a
refusal for a file that exists:

```text
$ aid resolve customers\acme-eu.yaml --out customers\acme-eu.spec.yaml
error: the overlay gate rejected "acme-eu": base "../app/app.spec.yaml" does not exist
[overlay/base-missing]
  hint: check the relative path from the overlay file
```

`customers/acme-eu.yaml` (forward slashes) resolves correctly — "3 overrides applied" — so the
document is fine and the diagnostic is wrong. The cause is that the base is joined with POSIX
rules: `basePathOf` calls `parentPath` (`packages/cli/src/overlays.ts:61-65`), and `parentPath`
splits only on `/` (`packages/cli/src/paths.ts:28-31`), so `customers\acme-eu.yaml` yields an
empty directory and `../app/app.spec.yaml` is then resolved against the working directory.

This is a genuine usability bug on Windows: the hint tells the reader to check a path that is
already correct. It is **not** in the round-5 brief. Proposal: a one-line normalisation in
`parentPath` (treat `\` as a separator) plus a test that resolves an overlay from a backslash
path. It changes no spec semantics and no generated output, so it can ride with Phase C, which
is the other small `packages/cli`-adjacent hardening.

## 8. Proposed work, phase order and effort

The brief's order (A, B, C, D) still holds, but **A shrinks**: the copy is already correct, so A
becomes "make the site's correctness detectable" rather than "correct the site". That is why A
is first — it is the smallest change with the highest chance of catching the next round of the
same complaint.

| Phase | Work | Effort |
| --- | --- | --- |
| **A** | Post-deploy live assertion with backoff, plus a test that keeps the homepage example compiling | ~0.5 day |
| **B** | One `pnpm check` that runs CI's checks in CI's order over the whole tree; truthful `lefthook.yml`; opt-in pre-push; the agent rule about `node_modules` | ~1 day |
| **C** | Case-insensitive cloud refusal + the Windows `parentPath` fix | ~0.5 day |
| **D** | `docs/guide/boundary.md`, linked from nav, Delivery playbook and homepage | ~1 day |

### Phase A — the site is checked, not assumed

1. **Post-deploy assertion.** Add a job after `deploy` in `docs.yml` that fetches
   `https://aid-framework.github.io/aid-framework/`, retries with exponential backoff (six
   attempts over ~10 minutes, because the CDN serves `max-age=600`), and fails the workflow
   when the rendered version is not `currentVersion()` from `site/.vitepress/config.mts`. This
   is a *post*-deploy check on a workflow that is deliberately not a required check: it informs
   and can be re-run, and it never blocks a merge or a tag.
2. **The homepage example is a fixture.** Add a test that reads the YAML fences out of
   `docs/index.md`, concatenates the base fragments, and asserts `buildIR` accepts the result,
   that every `overridable` path exists in the base, and that the overlay's `overrides` keys are
   a subset of them. This is the smallest thing that would have failed for the round-3
   "abridged" defect, and it is the same byte-asserted philosophy the fixtures already use.
3. **No copy changes are proposed.** I found no defect in the current text; changing correct
   copy to match a stale observation would be the dishonesty this project refuses.

### Phase B — the local gate cannot be skipped

1. **`pnpm check` becomes the whole thing**, in CI's order: `build` → `lint` → `typecheck` →
   `test:coverage` → `lint:actions` → `lint:licenses` → `docs:check` → `docs:build` →
   `docs:head` → `docs:links` → `docs:a11y` → `e2e` → `e2e:ts`. Each step prints one line and
   the run ends with a summary of what ran, so a failure is attributable.
2. **`pnpm check:all`** adds what needs a toolchain that may be absent — Python (`pytest`,
   `ruff`, `mypy`), `tofu validate`, `cdk synth`, the conformance harness — and prints
   `skipped: <tool> not installed` per step rather than silently passing. Skipping must be
   visible, and a skipped step must never be reported as a pass.
3. **Truthful `lefthook.yml`**, and an opt-in pre-push hook (`core.hooksPath` documented in
   `CONTRIBUTING.md`) that runs `pnpm check`. Not mandatory; stated as required before a push.
4. **The agent rule**, in `AGENTS.md` (created if absent) and `CONTRIBUTING.md`: never delete
   `node_modules` or anything under a pnpm workspace — they hold the workspace junctions —
   and reinstall with `corepack pnpm install --frozen-lockfile`. This is the round-4 incident
   recorded as a rule.
5. **Acceptance:** a script-level test that copies the tree to a temp directory, introduces a
   language-less fence and a stale registry count in turn, and asserts `pnpm check` exits
   non-zero and names the file — the same failure that reached CI in round 4.

### Phase C — a capitalised cloud is still a cloud

The question the brief leaves open is whether the schema should admit uppercase. My
recommendation: **admit it, and still refuse it** — widen the pattern to
`^[A-Za-z][A-Za-z0-9-]{1,30}$` so the IR can name the refusal, and keep every capitalised name
a build error:

| `cloud:` | Code | Why |
| --- | --- | --- |
| `Azure`, `AZURE`, `Kubernetes` | `ir/cloud-unsupported` (case-insensitive match) | it *is* the product AID has deferred; the fix is the capability matrix |
| `AWS`, `Gcp` | `ir/deploy-target-unknown`, with a hint "cloud names are lower-case; did you mean `aws`?" | the fix is the spelling, and it keeps the accepted grammar identical |
| `awz` | `ir/deploy-target-unknown` (unchanged) | not a cloud name at all |

**No `specVersion` bump**, and this time for a reason worth stating: after the change, exactly
the same set of documents builds as before. `Azure` used to be refused in the schema and is now
refused in the IR; `AWS` was refused and stays refused. Only the diagnostic improves. The
migration note says this in one sentence, and the registry count does not move because no new
code is registered — the case-mismatch hint reuses `ir/deploy-target-unknown`, whose fix really
is a spelling.

Tests: one per capitalisation (`Azure`, `AZURE`, `Kubernetes`, `AWS`, `awz`), asserting the code
*and* that the hint names the right destination. Plus the `parentPath` fix from §7 and its test.

### Phase D — the boundary page

`docs/guide/boundary.md`, written as a procedure for a reviewer, not a pitch. One row per
concern — identity and token verification, authorization, resume checkpoints, durable state,
secrets, network, audit, redaction and trace data, model and prompt pinning, eval and cost
gates, deployment and rollback — with four columns: **what the build refuses** (the named
diagnostic), **what is generated**, **what you must provide**, and **the residual risk if you
provide nothing**. Every row links its spec field, CLI command and diagnostic.

The page adds no new claims: it assembles the ten rows of `delivery.md:316-361`, the two
`features.md:503-515` triads and the field reference into one table, and states explicitly where
the answer is "you provide this". It carries a short "Reviewer checklist for the enterprise
profile" mapping each profile requirement to where it is enforced. `check-docs-claims` already
walks every `docs/**/*.md` file (`scripts/check-docs-claims.mjs:1134`), so the new page is
covered by the existing claim verification with no script change — the claims it makes about
diagnostics and commands must be ones the CLI actually implements, which is the point.

Linked from the Guide nav, `docs/guide/delivery.md` and the homepage's "Where to go next".

## 9. Smallest first increment

**Phase A, item 1 only**: the post-deploy assertion. It is about forty lines in one workflow,
it needs no spec change and no generator change, and it converts "the published site might be
wrong and nobody would know" into a red workflow run. Item 2 (the homepage fixture) follows in
the same PR because it is the other half of the same property — the site's content is checked,
not assumed.

I am stopping here for review, per the brief.

---

## 10. Where the repository contradicts this brief

| Brief says | Repository says | Resolution |
| --- | --- | --- |
| The live homepage still shows `0.1.162` and every defect #201 fixed | It shows `0.1.168` with all five fixes, on three URLs, at two cache ages (§2) | Treated as UNCLEAR. Phase A builds the detector instead of rewriting correct copy |
| Phase A should correct the homepage copy | The copy is already correct and the example validates and resolves (§1) | A shrinks to detection plus a fixture test |
| `pnpm check` exists but can be skipped | A `check` script exists and is *narrower* than CI; `lefthook.yml:1` says otherwise (§5) | Phase B makes the claim true |
