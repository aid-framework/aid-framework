# Conformance

The conformance corpus is a set of language-neutral behaviours that both runtimes must reproduce. It currently holds **73 cases** across **40 operations**. The list below is generated from `conformance/corpus.json`.

A case names a behaviour, not an implementation: `id` identifies it, `op` selects the operation, `input` is the fixture and `expect` is the observable outcome. Neither runtime is named anywhere in a case, so each runner maps the same fixture onto its own types. Each case is a test in both `runtimes/python` and `runtimes/typescript`; a case that applies to only one runtime carries a `runtimes` scope and a `reason`, and the other runner reports it as `scoped-out` rather than skipping it silently.

## Cases per operation

| Operation | Cases |
| --- | --- |
| [`agent.budget`](#agent-budget) | 1 |
| [`agent.delegate`](#agent-delegate) | 1 |
| [`agent.engine`](#agent-engine) | 4 |
| [`agent.guardrail`](#agent-guardrail) | 5 |
| [`agent.memory`](#agent-memory) | 1 |
| [`agent.resume`](#agent-resume) | 1 |
| [`agent.steps`](#agent-steps) | 1 |
| [`agent.transfer`](#agent-transfer) | 1 |
| [`alias.require`](#alias-require) | 1 |
| [`alias.resolve`](#alias-resolve) | 1 |
| [`alias.table`](#alias-table) | 1 |
| [`alias.unknown`](#alias-unknown) | 1 |
| [`budget.estimate`](#budget-estimate) | 1 |
| [`budget.ledger`](#budget-ledger) | 4 |
| [`eval.assert`](#eval-assert) | 7 |
| [`eval.gate`](#eval-gate) | 7 |
| [`eval.gate-summary`](#eval-gate-summary) | 1 |
| [`eval.z-critical`](#eval-z-critical) | 1 |
| [`memory.store`](#memory-store) | 1 |
| [`prompt.latest`](#prompt-latest) | 2 |
| [`prompt.render`](#prompt-render) | 3 |
| [`retrieval.bm25`](#retrieval-bm25) | 1 |
| [`retrieval.lexical-score`](#retrieval-lexical-score) | 1 |
| [`retrieval.ranking`](#retrieval-ranking) | 1 |
| [`retrieval.rrf`](#retrieval-rrf) | 1 |
| [`retrieval.similarity`](#retrieval-similarity) | 1 |
| [`steps.agent`](#steps-agent) | 1 |
| [`steps.branch`](#steps-branch) | 3 |
| [`steps.depth`](#steps-depth) | 2 |
| [`steps.emit`](#steps-emit) | 1 |
| [`steps.generate`](#steps-generate) | 1 |
| [`steps.guard`](#steps-guard) | 1 |
| [`steps.map`](#steps-map) | 2 |
| [`steps.parallel`](#steps-parallel) | 3 |
| [`steps.reduce`](#steps-reduce) | 1 |
| [`steps.rerank`](#steps-rerank) | 1 |
| [`steps.retrieve`](#steps-retrieve) | 1 |
| [`steps.tool`](#steps-tool) | 1 |
| [`structured.parse`](#structured-parse) | 2 |
| [`structured.repair`](#structured-repair) | 2 |

## `agent.budget` {#agent-budget}

- `agent-budget-hard-fail` — Decision D1: a breached cost ceiling is a hard failure, not a truncated run. With no onBudgetExhausted declaration the agent does not degrade, so the run raises rather than answering from a cheaper model.

## `agent.delegate` {#agent-delegate}

- `agent-delegate-returns-control` — delegates is delegation, not transfer. The control tool is named delegate_to_&lt;agent&gt;; the delegate gets an isolated context and its answer arrives back as one observation, so the caller still produces the final answer and the path does not grow.

## `agent.engine` {#agent-engine}

- `agent-engine-native-explicit` — Naming the native engine explicitly changes nothing: it is the default, the loop runs, and the run reports the same shape an agent that named no engine reports.
- `agent-engine-unknown-refused` — engine selects the backend, so an unrecognised value is a configuration error rather than a run: an ignored field would make the IR claim a backend the runtime is not executing.
- `agent-engine-transfer-refused` — handoffs is transfer, and Deep Agents has only subagents, which delegate and return. The engine refuses by name instead of degrading the transfer into a delegate that would change who authors the final answer.
- `agent-engine-version-mismatch-refused` — A deepagents agent must name the release this runtime was built against. A declared version the runtime is not pinned to fails closed, which is the comparison the IR gate's demand for a pinned engineVersion exists to make possible.

## `agent.guardrail` {#agent-guardrail}

- `guardrail-input-block` — The input stage blocks before the model is called: an injected instruction in the user's turn stops the run, and the error names the guardrail and the stage that stopped it.
- `guardrail-output-redact` — The output stage redacts the field the guardrail names: the answer ships with the email masked, not withheld, and the run still completes.
- `guardrail-input-flag` — A flag does not stop anything: the run completes with the answer the model produced and the match is recorded on the result, which is what the flag is for.
- `guardrail-input-escalate` — An escalate pauses the run for a person instead of failing it: the status is paused, not an error, and the checkpoint the caller needs is on the result.
- `guardrail-tool-call-block` — The tool-call stage runs over the arguments before the handler body: a credential in an argument blocks the call, and the block is attributed to the tool-call stage.

## `agent.memory` {#agent-memory}

- `agent-memory-scope` — A user-scoped memory is visible to the next run in the same thread and invisible to another thread, and the model's own prompt is where that difference is observable. The keys are thread ids, not sessions.

## `agent.resume` {#agent-resume}

- `agent-resume-across-json` — A run stops at a tool that requires confirmation, the checkpoint survives a JSON round trip, and the approved run continues from the same step. The confirmation is declared on the tool rather than in a policy, which is the source P7b's route predicate has to notice without a humanInTheLoop.

## `agent.steps` {#agent-steps}

- `agent-step-exhaustion` — An agent that keeps calling tools stops at maxSteps and produces no answer; the step ceiling is a stop condition, not an error and not a retry.

## `agent.transfer` {#agent-transfer}

- `agent-transfer-moves-control` — handoffs is transfer of control. The control tool is named transfer_to_&lt;agent&gt;; calling it means the caller never answers again and the target inherits the conversation, produces the final answer and extends the path.

## `alias.require` {#alias-require}

- `alias-capability-missing` — A required capability the pinned model does not declare fails loudly and names it.

## `alias.resolve` {#alias-resolve}

- `alias-pinned-resolution` — An alias resolves to the exact pinned provider model id, not to a provider default.

## `alias.table` {#alias-table}

- `alias-table-sorted` — The visible alias table is sorted, so a diagnostic about it is stable regardless of declaration order.

## `alias.unknown` {#alias-unknown}

- `alias-unknown-is-closed` — The alias table is closed: an unknown alias is a configuration error that lists the pinned aliases, never a pass-through.

## `budget.estimate` {#budget-estimate}

- `budget-cost-estimate` — A call's price is per-1k-token pricing over the reported usage, rounded to six decimals.

## `budget.ledger` {#budget-ledger}

- `budget-ledger-summary` — The ledger accumulates every charge, total tokens, and per-model spend.
- `budget-usd-exceeded` — A USD ceiling crossed after charging reports the overspend, and the ledger still shows the spend that crossed it.
- `budget-token-exceeded` — A token ceiling crossed after charging reports the overflow in tokens, not dollars.
- `budget-boundary-equal-spend-passes` — The ceiling refuses only spend that is strictly greater than it; spending exactly the ceiling is allowed.

## `eval.assert` {#eval-assert}

- `eval-assert-passes` — A predicate that holds scores 1.0 and carries no detail; the spec's message is reserved for a real failure.
- `eval-assert-fails-carries-message` — A predicate that does not hold scores 0.0 and reports the spec's own message verbatim, because the author wrote it to be quoted.
- `eval-assert-unbound-metadata-raises` — A metadata key the case does not carry raises instead of reading as false: a typo must not silently make every case fail.
- `eval-assert-type-mismatch-raises` — Comparing a string to a number raises. Equality is not silently undefined across types, and a boolean is never admitted as the number 1.
- `eval-assert-non-boolean-raises` — The whole predicate must be boolean. A bare path is a string, and scoring it would turn a string into a truthiness verdict.
- `eval-assert-no-short-circuit` — Both sides of a conjunction are evaluated even when the left is already false, so a misconfigured operand surfaces instead of being masked.
- `eval-assert-length-ordering` — Ordering compares numbers, so a length() result can be bounded inclusively. Both runtimes must normalize integer literals and lengths the same way for this to agree.

## `eval.gate` {#eval-gate}

- `eval-gate-standard-error` — The regression statistic divides the delta by the standard error of the difference of two means, so both spreads contribute: the same drop is judged against the noise in the run and in the baseline.
- `eval-gate-degenerate-distributions` — Two degenerate distributions have no standard error to divide by: a drop is then infinitely significant while an unchanged mean is not a drop at all. Both are decided on the delta branch or the infinite statistic, never by dividing by zero.
- `eval-gate-floor-breach` — The absolute floor is independent of the baseline: a mean under it fails before any comparison, and the rationale says which floor.
- `eval-gate-within-delta` — A drop inside max_regression passes on the delta alone, without a significance test.
- `eval-gate-noise-tolerated` — A drop beyond max_regression still passes when a noisy baseline leaves the z statistic inside the critical value: variation is not a regression.
- `eval-gate-regression` — The same run against a tight baseline is a regression: the delta is beyond max_regression and the z statistic is beyond the critical value.
- `eval-gate-min-mean-floor-beats-regression-allowance` — A 0/1 metric cannot be compared only by delta: here the mean improved on the baseline and would pass the regression allowance, and the absolute floor is what fails it.

## `eval.gate-summary` {#eval-gate-summary}

- `eval-gate-summary` — The gate's human-readable summary names the dataset, the run count, whether the run varied, and marks each metric.

## `eval.z-critical` {#eval-z-critical}

- `eval-z-critical-table` — The critical value is taken from the tabulated levels at or below alpha, so an untabulated alpha rounds to the next stricter level and anything stricter than the table gets the strictest value.

## `memory.store` {#memory-store}

- `memory-file-store-survives-a-second-instance` — A file-backed tier is durable: values appended through one store are read back through a second store on the same path, and a different scope sees none of them. InProcessMemoryStore is already covered by agent-memory-scope; durability is the property that distinguishes this backend.

## `prompt.latest` {#prompt-latest}

- `prompt-registry-latest` — Rendering without an explicit version resolves the newest registered version of the prompt.
- `prompt-unknown-name` — An unknown prompt name is a not-found error that lists the registered names.

## `prompt.render` {#prompt-render}

- `prompt-render-padded` — Fields are substituted in one pass, right-alignment pads to width, and doubled braces stay literal.
- `prompt-missing-variable` — A missing variable is refused by name rather than rendered as an empty string.
- `prompt-unused-variable` — A supplied variable the template never interpolates is a typo, not harmless input, and is refused alongside the variables the template does use.

## `retrieval.bm25` {#retrieval-bm25}

- `retrieval-bm25-scores` — BM25 saturates term frequency and normalises by document length; the scores are a pure function of the corpus and query.

## `retrieval.lexical-score` {#retrieval-lexical-score}

- `retrieval-lexical-rerank` — The lexical reranker scores query-term coverage and breaks ties toward an exact phrase match, bounded so it cannot promote an unrelated passage.

## `retrieval.ranking` {#retrieval-ranking}

- `retrieval-lexical-ranking` — The lexical ranking drops zero-scoring documents, orders by score and breaks ties on chunk id.

## `retrieval.rrf` {#retrieval-rrf}

- `retrieval-rrf-fusion` — Reciprocal rank fusion sums 1/(k+rank) over rankings, so agreement between retrievers outranks a single top hit.

## `retrieval.similarity` {#retrieval-similarity}

- `retrieval-cosine-similarity` — Cosine, dot and negative-L2 similarity against a fixed vector fixture, oriented so a larger number is a better match.

## `steps.agent` {#steps-agent}

- `steps-agent-charges-the-enclosing-runs-ledger` — An agent step builds its runtime over the enclosing gateway, so the call it makes is recorded on that gateway's ledger: a step that brought its own ledger would spend outside the pipeline's budget while looking identical from outside.

## `steps.branch` {#steps-branch}

- `steps-branch-takes-then-when-the-principal-satisfies-the-policy` — A branch whose principal satisfies its policy runs the then arm and binds what that arm bound.
- `steps-branch-takes-otherwise-when-the-principal-does-not` — The same branch decides for a principal without the role: the alternative runs and the then arm never does.
- `steps-branch-with-no-alternative-binds-nothing` — A branch with no alternative runs neither arm when the policy fails, and binds nothing rather than an empty or stale value.

## `steps.depth` {#steps-depth}

- `steps-depth-allows-nesting-up-to-the-bound` — A nest of composites exactly at the bound runs, and the leaf observes the depth it ran at.
- `steps-depth-refuses-nesting-past-the-bound` — One level past the bound is refused rather than run, and the refusal names the bound.

## `steps.emit` {#steps-emit}

- `steps-emit-projects-the-declared-fields` — An emit step projects each field of the event from the binding its source names, and the run continues past it.

## `steps.generate` {#steps-generate}

- `steps-generate-renders-then-binds-the-completion` — A generate step renders its prompt before the call and binds the answer the model returned.

## `steps.guard` {#steps-guard}

- `steps-guard-inspects-the-passages-a-retrieval-step-would-splice` — A retrieval-stage guard is handed the texts of the items in the binding, not the query, so a contact detail that exists only in a passage is refused -- the projection is the whole point of the stage, and a step that checked the query would allow this.

## `steps.map` {#steps-map}

- `steps-map-runs-the-body-once-per-item-in-input-order` — A map runs its body once per item and binds the per-item results in input order, each iteration seeing its own item and position.
- `steps-map-over-an-empty-list-binds-an-empty-list` — A map over an empty list runs no iteration and binds the empty list rather than binding nothing.

## `steps.parallel` {#steps-parallel}

- `steps-parallel-holds-the-cap-while-running-every-arm` — Three arms under a cap of two reach a ceiling of exactly two: the cap bounds the fan-out rather than merely being available to it.
- `steps-parallel-keeps-input-order-when-arms-finish-in-reverse` — The declared arm order is the binding order even when every arm finishes before the one before it.
- `steps-parallel-with-no-arms-binds-nothing` — A parallel with no arms runs nothing, binds nothing, and never takes a slot.

## `steps.reduce` {#steps-reduce}

- `steps-reduce-collects-per-item-results-in-input-order` — A reduce binds its collected results in input order even though the last item is the first to finish.

## `steps.rerank` {#steps-rerank}

- `steps-rerank-narrows-the-binding-it-reads-and-keeps-its-provenance` — A rerank step with topN 2 keeps the two best-covering passages in the reranker's order, re-ranks them from 1, and leaves the binding's own query and retriever alone -- the step reads the query but does not own it.

## `steps.retrieve` {#steps-retrieve}

- `steps-retrieve-binds-the-result-it-was-asked-for` — A retrieve step searches with the query and ceiling it was given and binds the whole result it got back.

## `steps.tool` {#steps-tool}

- `steps-tool-binds-the-parsed-content-under-the-binding-name` — A tool step calls the declared tool with the declared arguments, names the call after its binding, and binds the parsed content.

## `structured.parse` {#structured-parse}

- `structured-parse-fenced` — A ```json fence is presentation, not invalidity: the payload inside it validates.
- `structured-empty-output` — Whitespace-only output is reported as an empty output for the named type instead of a JSON parse failure.

## `structured.repair` {#structured-repair}

- `structured-repair-loop` — Each failed attempt appends the correction turn to the same original prompt, and the final error counts attempts twice: once from the failure and once from the exception's own suffix.
- `structured-repair-recovers` — A repair attempt that returns valid JSON ends the loop and yields the parsed value.

---

This page is generated from the source by `site/scripts/gen-reference.mjs`. Do not edit it by hand: run `pnpm --filter @aid-framework/docs gen` and commit the result.

Next: [the target matrix](./targets.md) or [the eval metrics](./eval-metrics.md).
