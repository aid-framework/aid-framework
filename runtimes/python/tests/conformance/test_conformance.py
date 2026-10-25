"""Run the shared conformance corpus against the Python runtime.

``conformance/corpus.json`` at the repository root is the single definition of the
behaviour both runtimes must agree on. This module is one of its two consumers: it
resolves that same file, executes every case against the real runtime code, and
reduces each outcome to a language-neutral verdict the TypeScript runner can be
diffed against.

Run it directly to print the resolved corpus path and the pass count, optionally
writing the verdicts for the other runtime to diff:

    python tests/conformance/test_conformance.py [verdicts.json]

Because that second invocation is how CI runs it, this module may import only the
standard library and the runtime's own dependencies: CI installs the runtime with
``pip install -e runtimes/python`` and no dev extras, so a ``pytest`` import here
passes locally and fails in CI. ``test_the_runner_runs_without_the_dev_extras``
holds that line.
"""

from __future__ import annotations

import asyncio
import json
import math
import runpy
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from aid_runtime import (
    AgentRuntime,
    AidRuntimeError,
    BaselineGate,
    Budget,
    BudgetExceededError,
    Capability,
    CapabilityMismatchError,
    CostLedger,
    CostProfile,
    DistanceMetric,
    EvalBaseline,
    EvalRun,
    FakeProvider,
    GateResult,
    InProcessMemoryStore,
    LedgerEntry,
    MetricBaseline,
    MetricRun,
    ModelGateway,
    ModelSpec,
    PromptNotFoundError,
    PromptRegistry,
    PromptRenderError,
    PromptTemplate,
    ScriptedTurn,
    StructuredOutputError,
    Threshold,
    TokenUsage,
    Tool,
    UnknownModelAliasError,
    bm25_scores,
    estimate_cost_usd,
    fuse,
    lexical_ranking,
    lexical_score,
    parse_structured,
    run_structured,
    similarity,
    z_critical,
)

#: ``tests/conformance/test_conformance.py`` is four levels below the repository root.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_CORPUS_PATH = _REPO_ROOT / "conformance" / "corpus.json"

#: Float comparisons are absolute. The two runtimes differ only in summation order, so
#: a real behavioural difference is orders of magnitude larger than this and the last
#: decimal place of any pinned value is still decided by the corpus.
_TOLERANCE = 1e-9


class Answer(BaseModel):
    """The schema the ``structured.*`` cases ask for, by its corpus name."""

    answer: str
    score: int


_OUTPUT_TYPES: dict[str, type[BaseModel]] = {"Answer": Answer}


def _spec(payload: Mapping[str, Any]) -> ModelSpec:
    return ModelSpec(
        name=str(payload["name"]),
        provider=str(payload["provider"]),
        cost=CostProfile(
            input_per_1k_usd=float(payload["cost"]["inputPer1kUsd"]),
            output_per_1k_usd=float(payload["cost"]["outputPer1kUsd"]),
        ),
        context_window=int(payload["contextWindow"]),
        max_output_tokens=int(payload["maxOutputTokens"]),
        capabilities=frozenset(Capability(value) for value in payload["capabilities"]),
    )


def _gateway(payload: Mapping[str, Any]) -> ModelGateway:
    aliases = {alias: _spec(spec) for alias, spec in payload["aliases"].items()}
    return ModelGateway(providers={"fake": FakeProvider(name="fake")}, aliases=aliases)


def _cost(payload: Mapping[str, Any]) -> CostProfile:
    return CostProfile(
        input_per_1k_usd=float(payload["inputPer1kUsd"]),
        output_per_1k_usd=float(payload["outputPer1kUsd"]),
    )


#: Every error the corpus can observe, in the order to test it. The name on the right is
#: the neutral kind the corpus pins; the class on the left is this runtime's own spelling.
_ERROR_KINDS: tuple[tuple[type[BaseException], str], ...] = (
    (UnknownModelAliasError, "unknown-alias"),
    (CapabilityMismatchError, "capability-mismatch"),
    (BudgetExceededError, "budget-exceeded"),
    (PromptNotFoundError, "prompt-not-found"),
    (PromptRenderError, "prompt-render"),
    (StructuredOutputError, "structured-output"),
)


def _error(exc: BaseException) -> dict[str, Any]:
    for kind_of, kind in _ERROR_KINDS:
        if isinstance(exc, kind_of):
            return {"kind": kind, "message": str(exc)}
    raise exc


def _error_from(call: Callable[[], Any]) -> dict[str, Any]:
    """The neutral error verdict for ``call``, or a marker that it did not raise."""
    try:
        call()
    except AidRuntimeError as exc:
        return _error(exc)
    return {"kind": "no-error", "message": ""}


def _alias_resolve(data: Mapping[str, Any]) -> dict[str, Any]:
    try:
        pinned = _gateway(data).resolve(data["alias"])
    except AidRuntimeError as exc:
        return {"error": _error(exc)}
    spec = pinned.spec
    return {
        "alias": pinned.alias,
        "model": spec.name,
        "provider": spec.provider,
        "contextWindow": spec.context_window,
        "maxOutputTokens": spec.max_output_tokens,
        "capabilities": sorted(capability.value for capability in spec.capabilities),
        "cost": {
            "inputPer1kUsd": spec.cost.input_per_1k_usd,
            "outputPer1kUsd": spec.cost.output_per_1k_usd,
        },
    }


def _alias_unknown(data: Mapping[str, Any]) -> dict[str, Any]:
    gateway = _gateway(data)
    return {"error": _error_from(lambda: gateway.resolve(data["alias"]))}


def _alias_require(data: Mapping[str, Any]) -> dict[str, Any]:
    gateway = _gateway(data)
    required = [Capability(value) for value in data["capabilities"]]
    return {"error": _error_from(lambda: gateway.require(data["alias"], required))}


def _alias_table(data: Mapping[str, Any]) -> dict[str, Any]:
    return {"aliases": list(_gateway(data).aliases)}


def _budget_estimate(data: Mapping[str, Any]) -> dict[str, Any]:
    usage = TokenUsage(
        input_tokens=int(data["usage"]["inputTokens"]),
        output_tokens=int(data["usage"]["outputTokens"]),
    )
    spec = ModelSpec(
        name="priced",
        provider="fake",
        cost=_cost(data["cost"]),
        context_window=128000,
        max_output_tokens=16384,
    )
    return {"costUsd": estimate_cost_usd(spec, usage)}


def _budget_ledger(data: Mapping[str, Any]) -> dict[str, Any]:
    payload = data["budget"]
    budget = (
        None
        if payload is None
        else Budget(
            max_usd=None if payload.get("maxUsd") is None else float(payload["maxUsd"]),
            max_total_tokens=(
                None if payload.get("maxTotalTokens") is None else int(payload["maxTotalTokens"])
            ),
            scope=str(payload["scope"]),
        )
    )
    profile = _cost(data["cost"])
    ledger = CostLedger()
    error: dict[str, Any] = {"kind": "no-error", "message": ""}
    for charge in data["charges"]:
        usage = TokenUsage(
            input_tokens=int(charge["inputTokens"]),
            output_tokens=int(charge["outputTokens"]),
        )
        try:
            ledger.charge(
                budget,
                LedgerEntry(
                    alias=str(charge["alias"]),
                    model=str(charge["model"]),
                    provider=str(charge["provider"]),
                    usage=usage,
                    cost_usd=profile.cost_usd(usage),
                ),
            )
        except BudgetExceededError as exc:
            # A refused charge ends the run: the caller stops spending, and the
            # corpus pins the ledger as it stood at the moment of refusal.
            error = _error(exc)
            break
    summary = ledger.summary()
    return {
        "error": error,
        "summary": {
            "calls": summary.calls,
            "inputTokens": summary.input_tokens,
            "outputTokens": summary.output_tokens,
            "costUsd": summary.cost_usd,
            "byModel": dict(sorted(summary.by_model.items())),
        },
    }


def _rendered(rendered: Any) -> dict[str, Any]:
    return {"name": rendered.name, "version": rendered.version, "text": rendered.text}


def _prompt_render(data: Mapping[str, Any]) -> dict[str, Any]:
    template = PromptTemplate(
        name=str(data["name"]), version=str(data["version"]), template=str(data["template"])
    )
    try:
        return _rendered(template.render(**data["values"]))
    except AidRuntimeError as exc:
        return {"error": _error(exc)}


def _prompt_latest(data: Mapping[str, Any]) -> dict[str, Any]:
    registry = PromptRegistry(
        [
            PromptTemplate(
                name=str(entry["name"]),
                version=str(entry["version"]),
                template=str(entry["template"]),
            )
            for entry in data["templates"]
        ]
    )
    try:
        return _rendered(registry.render(str(data["name"]), values=data["values"]))
    except AidRuntimeError as exc:
        return {"error": _error(exc)}


def _structured_parse(data: Mapping[str, Any]) -> dict[str, Any]:
    output_type = _OUTPUT_TYPES[str(data["schema"])]
    try:
        return {"value": parse_structured(str(data["text"]), output_type).model_dump()}
    except AidRuntimeError as exc:
        return {"error": _error(exc)}


def _structured_repair(data: Mapping[str, Any]) -> dict[str, Any]:
    output_type = _OUTPUT_TYPES[str(data["schema"])]
    responses: Sequence[str] = data["responses"]
    prompts: list[str] = []

    async def call(prompt: str) -> str:
        prompts.append(prompt)
        return str(responses[len(prompts) - 1])

    try:
        value = asyncio.run(
            run_structured(call, output_type, str(data["prompt"]), retries=int(data["retries"]))
        )
    except AidRuntimeError as exc:
        return {"prompts": prompts, "error": _error(exc)}
    return {"prompts": prompts, "value": value.model_dump()}


def _ranked(ranking: Sequence[Any]) -> list[dict[str, Any]]:
    return [{"chunkId": entry.chunk_id, "score": entry.score} for entry in ranking]


def _retrieval_bm25(data: Mapping[str, Any]) -> dict[str, Any]:
    return {"scores": list(bm25_scores(data["documents"], str(data["query"])))}


def _retrieval_ranking(data: Mapping[str, Any]) -> dict[str, Any]:
    ranking = lexical_ranking(
        data["documents"], data["ids"], str(data["query"]), top_k=int(data["topK"])
    )
    return {"ranking": _ranked(ranking)}


def _retrieval_rrf(data: Mapping[str, Any]) -> dict[str, Any]:
    rankings = data["rankings"]
    # ``k`` null pins the recomputed default rather than restating the constant: a
    # corpus case that passed an explicit 60 would not notice the default changing.
    fused = fuse(rankings) if data["k"] is None else fuse(rankings, k=int(data["k"]))
    return {"ranking": _ranked(fused)}


def _retrieval_similarity(data: Mapping[str, Any]) -> dict[str, Any]:
    query = data["query"]
    return {
        "scores": {
            metric: [
                similarity(query, candidate, metric=DistanceMetric(metric))
                for candidate in data["candidates"]
            ]
            for metric in data["metrics"]
        }
    }


def _retrieval_lexical(data: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "scores": [lexical_score(str(data["query"]), str(text)) for text in data["texts"]],
    }


def _gate_result(result: GateResult) -> dict[str, Any]:
    return {
        "passed": result.passed,
        "dataset": result.dataset,
        "datasetVersion": result.dataset_version,
        "runs": result.runs,
        "varying": result.varying,
        "results": [
            {
                "metric": entry.metric,
                "passed": entry.passed,
                "currentMean": entry.current_mean,
                "currentStdev": entry.current_stdev,
                "baselineMean": entry.baseline_mean,
                "baselineStdev": entry.baseline_stdev,
                "delta": entry.delta,
                "z": entry.z,
                "alpha": entry.alpha,
                "maxRegression": entry.max_regression,
                "rationale": entry.rationale,
            }
            for entry in result.results
        ],
    }


def _evaluate(data: Mapping[str, Any]) -> GateResult:
    thresholds = [
        Threshold(
            metric=str(entry["metric"]),
            min_mean=None if entry["minMean"] is None else float(entry["minMean"]),
            max_regression=float(entry["maxRegression"]),
            alpha=float(entry["alpha"]),
        )
        for entry in data["thresholds"]
    ]
    run = EvalRun(
        dataset=str(data["run"]["dataset"]),
        dataset_version=str(data["run"]["datasetVersion"]),
        runs=int(data["run"]["runs"]),
        metrics=tuple(
            MetricRun(metric=str(entry["metric"]), values=tuple(entry["values"]))
            for entry in data["run"]["metrics"]
        ),
    )
    baseline = EvalBaseline(
        dataset=str(data["baseline"]["dataset"]),
        dataset_version=str(data["baseline"]["datasetVersion"]),
        model=str(data["baseline"]["model"]),
        metrics=tuple(
            MetricBaseline(
                metric=str(entry["metric"]),
                runs=int(entry["runs"]),
                mean=float(entry["mean"]),
                stdev=float(entry["stdev"]),
            )
            for entry in data["baseline"]["metrics"]
        ),
    )
    return BaselineGate(thresholds).evaluate(run, baseline)


def _eval_gate(data: Mapping[str, Any]) -> dict[str, Any]:
    return _gate_result(_evaluate(data))


def _eval_gate_summary(data: Mapping[str, Any]) -> dict[str, Any]:
    result = _evaluate(data)
    return {"passed": result.passed, "summary": result.summary()}


def _eval_z(data: Mapping[str, Any]) -> dict[str, Any]:
    return {"values": [{"alpha": a, "z": z_critical(float(a))} for a in data["alphas"]]}


# --- scoping ----------------------------------------------------------------------

#: Every runtime the corpus is written for. A case may name which of them it applies
#: to; naming none means all of them.
RUNTIMES: tuple[str, ...] = ("python", "typescript")

#: This runner's name, as a case spells it.
_SELF = "python"


def case_scope(case_id: str, case: Mapping[str, Any]) -> str | None:
    """Why this case is out of scope for this runtime, or None if it is in scope.

    A case that says nothing is in scope everywhere. A case that narrows the field
    must leave a reason behind, because "not implemented yet" and "not applicable"
    are indistinguishable from the outside -- and the difference decides whether the
    work is finished or merely deferred.

    The mechanism is deliberately strict in both directions: an unknown runtime name
    is an error rather than a typo that quietly narrows a case to nothing, a case
    that scopes itself away from every runtime is an error rather than a no-op, and
    a case that names this runtime still has to have its op implemented *here* --
    :func:`load_corpus` enforces that, which is what stops scope becoming a way to
    skip a case this runtime claims to check.
    """
    declared = case.get("runtimes")
    if declared is None:
        return None
    if not isinstance(declared, list) or not declared:
        raise ValueError(f"{case_id}: 'runtimes' must be a non-empty array of runtime names")
    bad = [item for item in declared if not isinstance(item, str) or item not in RUNTIMES]
    if bad:
        raise ValueError(
            f"{case_id}: 'runtimes' names {bad}; expected a subset of {list(RUNTIMES)}"
        )
    if len(set(declared)) != len(declared):
        raise ValueError(f"{case_id}: 'runtimes' names a runtime twice: {declared}")
    reason = case.get("reason")
    if reason is not None and not isinstance(reason, str):
        raise ValueError(f"{case_id}: 'reason' must be a string")
    # The reason is required whenever *any* runtime is left out, not only when this one
    # is. A corpus that narrower than its own declaration is malformed for every reader,
    # and a runner that only audits the cases it owns would wave it through: the gap is
    # in the shared artifact, so every runner has to refuse it.
    reason_text = reason.strip() if isinstance(reason, str) else ""
    left_out = [name for name in RUNTIMES if name not in declared]
    if left_out and not reason_text:
        raise ValueError(
            f"{case_id}: scoped away from {left_out} without a 'reason'; a case that some "
            "runtime does not check must say why, or the gap is invisible"
        )
    if _SELF in declared:
        return None
    return reason_text


def _in_scope(case: Mapping[str, Any]) -> bool:
    return case.get("_scope") is None


# --- the agent runtime ------------------------------------------------------------

_AGENT_PROVIDER = "fake"
_AGENT_CONTEXT = 128_000

_QUERY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "additionalProperties": False,
}

_AGENT_FIELDS = ("maxCostBudget", "maxTokensBudget", "onBudgetExhausted")


def _agent_document(data: Mapping[str, Any]) -> dict[str, Any]:
    """Expand the corpus's compact agent fixture into an emitted IR document.

    The corpus spells money per thousand tokens, like its alias cases do; the IR
    spells it per million. Converting here keeps one vocabulary in the corpus and
    one in the IR instead of a third somewhere between them.
    """
    models = [
        {
            "id": entry["id"],
            "modelId": f"{entry['id']}-1",
            "provider": _AGENT_PROVIDER,
            "capabilities": ["tool-calling"],
            "limits": {"contextTokens": _AGENT_CONTEXT, "maxOutputTokens": 4_096},
            "costProfile": {
                "inputPerMTok": float(entry.get("inputPer1kUsd", 0.0)) * 1_000.0,
                "outputPerMTok": float(entry.get("outputPer1kUsd", 0.0)) * 1_000.0,
            },
            "fallbacks": list(entry.get("fallbacks", [])),
        }
        for entry in data.get("models", [])
    ]
    prompts = [
        {
            "id": entry["id"],
            "version": 1,
            "template": entry["template"],
            "variables": {},
        }
        for entry in data.get("prompts", [])
    ]
    tools = [
        {
            "id": entry["id"],
            "name": entry["name"],
            "description": entry.get("description", f"{entry['name']} tool"),
            "requiresConfirmation": False,
            "sideEffects": "read",
        }
        for entry in data.get("tools", [])
    ]
    agents = []
    for entry in data.get("agents", []):
        agent: dict[str, Any] = {
            "id": entry["id"],
            "name": entry.get("name", entry["id"]),
            "instructions": entry["instructions"],
            "model": entry["model"],
            "maxSteps": entry["maxSteps"],
            "tools": list(entry.get("tools", [])),
            "handoffs": list(entry.get("handoffs", [])),
            "delegates": list(entry.get("delegates", [])),
            "memory": list(entry.get("memory", [])),
            "engine": entry.get("engine", "native"),
        }
        for field_name in _AGENT_FIELDS:
            if field_name in entry:
                agent[field_name] = entry[field_name]
        agents.append(agent)
    return {
        "version": "0.2.0",
        "models": models,
        "prompts": prompts,
        "tools": tools,
        "memory": [dict(entry) for entry in data.get("memory", [])],
        "agents": agents,
    }


def _scripted(step: Mapping[str, Any]) -> ScriptedTurn:
    if "tools" in step:
        return ScriptedTurn.tools(
            *[(str(name), dict(arguments)) for name, arguments in step["tools"]]
        )
    if "tool" in step:
        return ScriptedTurn.tool(str(step["tool"]), dict(step.get("arguments", {})))
    return ScriptedTurn.answer(str(step.get("text", "")))


def _echo(name: str) -> Callable[..., str]:
    def handler(query: str = "") -> str:
        return f"{name}:{query}"

    return handler


def _agent_runtime(data: Mapping[str, Any]) -> tuple[AgentRuntime, FakeProvider]:
    provider = FakeProvider(
        name=_AGENT_PROVIDER,
        script=[_scripted(step) for step in data.get("script", [])],
    )
    runtime = AgentRuntime.from_ir(
        _agent_document(data),
        providers={_AGENT_PROVIDER: provider},
        tools=[
            Tool.of(
                entry["name"],
                _echo(str(entry["name"])),
                description=entry.get("description", f"{entry['name']} tool"),
                parameters=_QUERY_SCHEMA,
            )
            for entry in data.get("tools", [])
        ],
        memory_store=InProcessMemoryStore(),
    )
    return runtime, provider


def _agent_verdict(result: Any) -> dict[str, Any]:
    """Reduce a run to the questions the corpus asks of one.

    ``finalAgent`` is the whole transfer/delegate distinction in one field: the
    agent that produced the answer. ``path`` says how control got there.
    """
    return {
        "status": str(result.status),
        "finalAgent": result.agent_id,
        "answer": result.answer,
        "path": list(result.path),
        "steps": [
            {
                "agent": step.agent_id,
                "kind": str(step.kind),
                "alias": step.alias,
                "tools": list(step.tool_names),
                "target": step.target,
                "degradedFrom": step.degraded_from,
            }
            for step in result.steps
        ],
        "degraded": [list(pair) for pair in result.degraded],
    }


def _agent_loop(data: Mapping[str, Any]) -> dict[str, Any]:
    """One run of one agent, to whatever stop condition it reaches."""

    async def run() -> dict[str, Any]:
        runtime, _ = _agent_runtime(data)
        try:
            result = await runtime.run(str(data.get("agent", "solo")), str(data["question"]))
        except BudgetExceededError:
            # D1's default: a breached ceiling is a hard failure, not a status.
            return {"error": "budget-exceeded"}
        return _agent_verdict(result)

    return asyncio.run(run())


def _agent_memory(data: Mapping[str, Any]) -> dict[str, Any]:
    """Repeated runs against named memory keys, observed by what the model saw."""

    async def run() -> dict[str, Any]:
        runtime, provider = _agent_runtime(data)
        agent = str(data.get("agent", "solo"))
        answers = []
        for key in data["memoryKeys"]:
            result = await runtime.run(agent, str(data["question"]), memory_key=str(key))
            answers.append(result.answer)
        return {
            "answers": answers,
            "messagesPerRun": [len(request.messages) for request in provider.calls],
        }

    return asyncio.run(run())


_OPS: dict[str, Callable[[Mapping[str, Any]], Any]] = {
    "alias.resolve": _alias_resolve,
    "alias.unknown": _alias_unknown,
    "alias.require": _alias_require,
    "alias.table": _alias_table,
    "budget.estimate": _budget_estimate,
    "budget.ledger": _budget_ledger,
    "prompt.render": _prompt_render,
    "prompt.latest": _prompt_latest,
    "structured.parse": _structured_parse,
    "structured.repair": _structured_repair,
    "retrieval.bm25": _retrieval_bm25,
    "retrieval.ranking": _retrieval_ranking,
    "retrieval.rrf": _retrieval_rrf,
    "retrieval.similarity": _retrieval_similarity,
    "retrieval.lexical-score": _retrieval_lexical,
    "eval.z-critical": _eval_z,
    "eval.gate": _eval_gate,
    "eval.gate-summary": _eval_gate_summary,
    "agent.steps": _agent_loop,
    "agent.budget": _agent_loop,
    "agent.transfer": _agent_loop,
    "agent.delegate": _agent_loop,
    "agent.memory": _agent_memory,
}


def _clean(value: Any) -> Any:
    """Make a verdict JSON-safe and stable across two float implementations.

    JSON has no spelling for the non-finite numbers. A degenerate distribution
    produces an infinite z, and that infinite statistic is the behaviour under test,
    so it is carried as ``"inf"`` rather than dropped.

    Finite floats are quantised to six decimal places. The two runtimes are separate
    summations of the same arithmetic, so their last bits differ; six places is the
    precision the corpus actually pins, and it is far below any behavioural
    difference. It also keeps the corpus readable and stops a summation artefact such
    as ``-1.1102230246251565e-16`` being pinned as if it were behaviour.
    """
    if isinstance(value, float):
        if math.isnan(value):
            return "nan"
        if math.isinf(value):
            return "inf" if value > 0 else "-inf"
        # ``-0.0 == 0.0``, so the sign is not behaviour; dropping it keeps the corpus
        # free of a distinction neither JSON nor the other runtime preserves.
        rounded = round(value, 6)
        return 0.0 if rounded == 0.0 else rounded
    if isinstance(value, Mapping):
        return {str(key): _clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(item) for item in value]
    return value


def load_corpus() -> dict[str, Any]:
    """The corpus this runtime resolves. The path is asserted by the caller.

    A corpus that cannot be executed unambiguously is a failure, not an empty
    run: duplicate ids would silently shadow each other, an unknown op would mean
    this runtime has no opinion on a case it claims to check, and a case that
    scopes itself away from a runtime without saying why would turn a gap into a
    silent pass.

    The op check applies to the cases *this* runtime claims. A case scoped to
    another runtime names an op this runtime may not implement yet, and refusing
    the whole corpus over it would make adding a case for one runtime impossible
    without first writing the other -- but a case that names this runtime still
    has to be runnable here, so scope can never be used to skip a case that was
    claimed.
    """
    corpus: dict[str, Any] = json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))
    seen: set[str] = set()
    for case in corpus["cases"]:
        case_id = str(case["id"])
        if case_id in seen:
            raise ValueError(f"duplicate case id in the corpus: {case_id}")
        seen.add(case_id)
        reason = case_scope(case_id, case)
        if reason is None and str(case["op"]) not in _OPS:
            raise ValueError(f"{case_id}: the corpus names an unknown op {case['op']!r}")
        case["_scope"] = reason
    return corpus


def build_verdicts(corpus: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Execute every in-scope case in corpus order and reduce it to a neutral verdict.

    A case that is out of scope is reported as such rather than omitted, so both
    runtimes' artefacts list the same ids and a population mismatch still means
    what it says.
    """
    verdicts: list[dict[str, Any]] = []
    for case in corpus["cases"]:
        if not _in_scope(case):
            verdicts.append({"id": case["id"], "status": "scoped-out", "reason": case["_scope"]})
            continue
        handler = _OPS[str(case["op"])]
        verdicts.append(
            {"id": case["id"], "status": "evaluated", "verdict": _clean(handler(case["input"]))}
        )
    return verdicts


def drift(expected: Any, observed: Any, path: str = "$") -> str | None:
    """The first place ``observed`` departs from ``expected``, or None.

    Numbers compare within a tolerance because the two runtimes are separate
    summations of the same arithmetic; everything else compares exactly.
    """
    if isinstance(expected, bool) or isinstance(observed, bool):
        return None if expected == observed else f"{path}: {expected!r} != {observed!r}"
    if isinstance(expected, (int, float)) and isinstance(observed, (int, float)):
        if abs(float(expected) - float(observed)) > _TOLERANCE:
            return f"{path}: {expected!r} != {observed!r}"
        return None
    if isinstance(expected, Mapping) and isinstance(observed, Mapping):
        if sorted(expected) != sorted(observed):
            return f"{path}: keys {sorted(expected)} != {sorted(observed)}"
        for key in sorted(expected):
            found = drift(expected[key], observed[key], f"{path}.{key}")
            if found is not None:
                return found
        return None
    if isinstance(expected, list) and isinstance(observed, list):
        if len(expected) != len(observed):
            return f"{path}: {len(expected)} items != {len(observed)} items"
        for index, (left, right) in enumerate(zip(expected, observed, strict=True)):
            found = drift(left, right, f"{path}[{index}]")
            if found is not None:
                return found
        return None
    return None if expected == observed else f"{path}: {expected!r} != {observed!r}"


def _report(corpus: Mapping[str, Any], verdicts: Sequence[Mapping[str, Any]]) -> list[str]:
    """Every in-scope case whose observed verdict disagrees with the corpus."""
    expected = {case["id"]: case["expect"] for case in corpus["cases"]}
    failures: list[str] = []
    for entry in verdicts:
        if entry.get("status") != "evaluated":
            continue
        found = drift(expected[entry["id"]], entry["verdict"])
        if found is not None:
            failures.append(f"{entry['id']}: {found}")
    return failures


def test_corpus_path_is_the_repository_corpus() -> None:
    """Both runtimes must read the same file, so the path is not incidental."""
    assert _CORPUS_PATH.is_file()
    assert _CORPUS_PATH.parent.name == "conformance"
    assert _CORPUS_PATH.parent.parent == _REPO_ROOT
    assert load_corpus()["cases"]


def test_python_runtime_matches_the_corpus() -> None:
    corpus = load_corpus()
    verdicts = build_verdicts(corpus)
    assert len(verdicts) == len(corpus["cases"])
    failures = _report(corpus, verdicts)
    assert not failures, "\n".join(failures)


def test_a_case_this_runtime_claims_must_have_a_handler() -> None:
    """Scope may defer a case; it may not let this runtime skip one it claimed."""
    for case in load_corpus()["cases"]:
        if case["_scope"] is None:
            assert case["op"] in _OPS, case["id"]


def test_scope_narrows_only_with_a_reason_and_a_known_runtime() -> None:
    assert case_scope("x", {}) is None
    assert case_scope("x", {"runtimes": list(RUNTIMES)}) is None
    assert case_scope("x", {"runtimes": ["python"], "reason": "later"}) is None
    assert case_scope("x", {"runtimes": ["typescript"], "reason": "later"}) == "later"
    malformed: tuple[tuple[Mapping[str, Any], str], ...] = (
        ({"runtimes": ["typescript"]}, "without a 'reason'"),
        ({"runtimes": ["typescript"], "reason": "  "}, "without a 'reason'"),
        # A reason is needed whenever *any* runtime is left out, not only when this
        # one is: the gap lives in the shared corpus, so every reader must refuse it.
        ({"runtimes": ["python"]}, "without a 'reason'"),
        ({"runtimes": []}, "must be a non-empty array"),
        ({"runtimes": ["rust"], "reason": "later"}, "expected a subset"),
        ({"runtimes": ["python", "python"]}, "names a runtime twice"),
        ({"runtimes": "python"}, "must be a non-empty array"),
    )
    for case, fragment in malformed:
        refusal = ""
        try:
            case_scope("x", case)
        except ValueError as exc:
            refusal = str(exc)
        assert refusal, f"case_scope accepted {case!r}"
        assert fragment in refusal, f"expected {fragment!r} in {refusal}"


def test_a_scoped_case_is_reported_rather_than_dropped() -> None:
    """Both artefacts must list every id, so a population mismatch still means one."""
    corpus = load_corpus()
    verdicts = build_verdicts(corpus)
    assert [entry["id"] for entry in verdicts] == [case["id"] for case in corpus["cases"]]
    for entry, case in zip(verdicts, corpus["cases"], strict=True):
        if case["_scope"] is None:
            assert entry["status"] == "evaluated"
            assert "reason" not in entry
        else:
            assert entry == {
                "id": case["id"],
                "status": "scoped-out",
                "reason": case["_scope"],
            }


def test_the_runner_runs_without_the_dev_extras(monkeypatch: Any) -> None:
    """CI executes this file as a script, with the runtime installed but not pytest.

    The venv has pytest, so the absence is simulated by halting its import: the same
    failure the ``conformance`` job reported for this runner, which a local run cannot
    otherwise reproduce.
    """
    monkeypatch.setitem(sys.modules, "pytest", None)
    monkeypatch.setattr(sys, "argv", [Path(__file__).name])
    status: object = "did not terminate"
    failure = ""
    try:
        runpy.run_path(str(Path(__file__).resolve()), run_name="__main__")
    except SystemExit as exc:
        status = exc.code
    except ImportError as exc:
        failure = str(exc)
    assert not failure, f"the runner must import without the dev extras: {failure}"
    assert status == 0, f"the runner exited with {status!r}"


def _write(path: str, corpus: Mapping[str, Any], verdicts: Sequence[Any]) -> None:
    Path(path).write_text(
        json.dumps(
            {
                "runtime": "python",
                "corpusPath": str(_CORPUS_PATH),
                "cases": list(verdicts),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main(argv: Sequence[str]) -> int:
    sys.stdout.write(f"corpus: {_CORPUS_PATH}\n")
    try:
        corpus = load_corpus()
    except ValueError as exc:
        sys.stdout.write(f"  {exc}\n")
        return 1
    verdicts = build_verdicts(corpus)
    failures = _report(corpus, verdicts)
    total = len(corpus["cases"])
    evaluated = sum(1 for entry in verdicts if entry["status"] == "evaluated")
    scoped = total - evaluated
    # The denominator is what this runtime was asked to evaluate, and the scoped count is
    # printed beside it rather than folded in. A run that silently checked fewer cases
    # would otherwise report a full pass over a corpus it had shrunk.
    sys.stdout.write(
        f"python: {evaluated - len(failures)}/{evaluated} evaluated "
        f"({len(failures)} failed), {scoped}/{total} scoped to other runtimes\n"
    )
    for entry in verdicts:
        if entry["status"] == "scoped-out":
            sys.stdout.write(f"  out of scope: {entry['id']} -- {entry['reason']}\n")
    for failure in failures:
        sys.stdout.write(f"  {failure}\n")
    if len(argv) > 1:
        _write(argv[1], corpus, verdicts)
    if total == 0:
        sys.stdout.write("  the corpus is empty; a run that checks nothing is a failure\n")
        return 1
    if evaluated == 0:
        sys.stdout.write(
            "  every case was scoped away from this runtime; a run that checks nothing "
            "is a failure\n"
        )
        return 1
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
