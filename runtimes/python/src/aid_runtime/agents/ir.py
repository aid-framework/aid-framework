"""The IR seam: an emitted document in, resolved agent definitions out.

``pipeline.py`` consumes the IR's *pipeline* shapes and is deliberately unaware of
agents; this module is the equivalent seam for them. It reads only the collections
an agent can reach -- ``agents``, ``models``, ``prompts``, ``tools``, ``memory``,
``guardrails`` -- and resolves every reference at load time, so a loop never runs
against a dangling prompt id or an unpriced model.

Nothing here invents vocabulary. Field names are the IR's, ``instructions`` stays
the prompt *reference* the IR carries and is resolved to ``prompt.template`` here,
and the scopes are ``thread``/``user``/``global``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from aid_runtime.errors import ConfigurationError
from aid_runtime.types import Capability, CostProfile, ModelSpec

__all__ = [
    "AgentDefinition",
    "GuardrailDefinition",
    "HumanApproval",
    "MemoryDefinition",
    "RuntimeSpec",
    "ToolSpec",
    "from_ir",
]

#: IR model capability -> runtime capability. The IR's ``json-schema`` is what the
#: runtime calls structured output; capabilities with no runtime counterpart
#: (``vision``, ``reasoning``, ``prompt-cache``, ``audio``) are dropped rather than
#: invented, because nothing in the loop negotiates them.
_RUNTIME_CAPABILITY: dict[str, Capability] = {
    "tool-calling": Capability.TOOL_CALLING,
    "json-schema": Capability.STRUCTURED_OUTPUT,
    "streaming": Capability.STREAMING,
    "long-context": Capability.LONG_CONTEXT,
    "embeddings": Capability.EMBEDDINGS,
    "rerank": Capability.RERANK,
}

_ON_BUDGET_EXHAUSTED = frozenset({"fail", "degrade"})

#: The closed vocabularies from ``packages/ir/src/shapes.ts``. They are repeated
#: here on purpose: the build-time gates reject an unknown name, and the runtime
#: rejects it again rather than trusting that every document came through a gate.
_GUARDRAIL_STAGES = frozenset({"input", "output", "retrieval", "tool-call"})
_GUARDRAIL_ACTIONS = frozenset({"block", "redact", "flag", "escalate"})
_GUARDRAIL_POLICIES = frozenset(
    {
        "pii-detect",
        "pii-redact",
        "prompt-injection",
        "jailbreak",
        "moderation",
        "toxicity",
        "secret-scan",
    }
)

_SIDE_EFFECTS = frozenset({"none", "read", "write", "destructive"})


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """An IR tool, as the loop needs it: name, side effects, and its auth policy."""

    id: str
    name: str
    description: str
    requires_confirmation: bool
    side_effects: str
    auth: Mapping[str, Any] | None


@dataclass(frozen=True, slots=True)
class GuardrailDefinition:
    """One resolved guardrail: where it runs, what it detects, and what it does.

    ``tools`` holds tool *ids*, because that is how the IR scopes a tool-call
    guardrail; the loop translates a model's tool *name* to the id before asking.
    """

    id: str
    stages: tuple[str, ...]
    policies: tuple[str, ...]
    action: str
    redact: tuple[str, ...]
    tools: tuple[str, ...]
    message: str
    fallback_prompt: str | None
    log: bool


@dataclass(frozen=True, slots=True)
class MemoryDefinition:
    """One IR ``memory`` entry, resolved for the scope rules in ``agents.memory``."""

    id: str
    kind: str
    scope: str
    token_budget: int
    backend: str | None
    store: str | None
    summarize_model: str | None
    ttl: str | None
    redact: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class HumanApproval:
    """The parsed ``humanInTheLoop`` block: a policy, and a channel to ask on."""

    when: Mapping[str, Any]
    channel: str


@dataclass(frozen=True, slots=True)
class AgentDefinition:
    """One agent, with every reference resolved."""

    id: str
    name: str
    instructions: str
    model: str
    tools: tuple[str, ...]
    memory: tuple[MemoryDefinition, ...]
    max_steps: int
    max_tokens_budget: int | None
    max_cost_budget: float | None
    on_budget_exhausted: str
    handoffs: tuple[str, ...]
    delegates: tuple[str, ...]
    engine: str
    # The pinned Deep Agents release, when the engine is ``deepagents``. Empty for
    # ``native``; the IR gate refuses ``deepagents`` without a pin, so an empty
    # value here means the document skipped the gate.
    engine_version: str
    approval: HumanApproval | None
    guardrails: tuple[GuardrailDefinition, ...] = ()

    @property
    def has_control_tools(self) -> bool:
        """Whether this agent may move control at all (transfer *or* delegate)."""
        return bool(self.handoffs or self.delegates)

    def stage_guardrails(self, stage: str) -> tuple[GuardrailDefinition, ...]:
        """Every guardrail declared on this agent that runs at ``stage``.

        Declaration order is the order of ``guardrails`` in the IR, and that is the
        order the engine evaluates in. It has to come from the document: an order
        the runtime invented would make the outcome of two conflicting guardrails
        depend on which version of the runtime ran the spec.
        """
        return tuple(guardrail for guardrail in self.guardrails if stage in guardrail.stages)


@dataclass(frozen=True, slots=True)
class RuntimeSpec:
    """Everything the loop needs, resolved from one IR document."""

    models: Mapping[str, ModelSpec]
    fallbacks: Mapping[str, tuple[str, ...]]
    prompts: Mapping[str, str]
    tools: Mapping[str, ToolSpec]
    agents: Mapping[str, AgentDefinition]
    guardrails: Mapping[str, GuardrailDefinition] = field(default_factory=dict)

    def agent(self, agent_id: str) -> AgentDefinition:
        try:
            return self.agents[agent_id]
        except KeyError:
            raise ConfigurationError(
                f"no agent {agent_id!r} in the IR; declared agents: {sorted(self.agents)}"
            ) from None

    def system_prompt(self, agent: AgentDefinition) -> str:
        try:
            return self.prompts[agent.instructions]
        except KeyError:
            raise ConfigurationError(
                f"agent {agent.id!r} names prompt {agent.instructions!r}, "
                f"which the IR does not declare; declared prompts: {sorted(self.prompts)}"
            ) from None

    def fallbacks_for(self, alias: str) -> tuple[str, ...]:
        return self.fallbacks.get(alias, ())

    def tool_specs(self, agent: AgentDefinition) -> tuple[ToolSpec, ...]:
        return tuple(self.tools[tool_id] for tool_id in agent.tools)

    def price(self, alias: str) -> float:
        """Combined price, the same number ``agents/budget-degrade`` compares.

        The gate compares ``inputPerMTok + outputPerMTok``; keeping the identical
        sum here means a spec the gate accepted cannot have the runtime pick a
        "cheaper" alias that the gate would have called more expensive.
        """
        spec = self.models[alias]
        return spec.cost.input_per_1k_usd + spec.cost.output_per_1k_usd

    def cheaper_fallback(self, alias: str) -> str | None:
        """The first declared fallback that is strictly cheaper than ``alias``.

        One step, in the order the spec declared: this is the alias ladder's next
        rung, not a search for the cheapest reachable model. ``None`` means there
        is nowhere to step, which is what makes a ``degrade`` declaration fail
        closed instead of pretending to degrade.
        """
        budget = self.price(alias)
        for candidate in self.fallbacks_for(alias):
            if candidate in self.models and self.price(candidate) < budget:
                return candidate
        return None


def from_ir(document: Mapping[str, Any]) -> RuntimeSpec:
    """Resolve an emitted IR document into a :class:`RuntimeSpec`."""
    raw_models = _by_id(document.get("models"), "models")
    raw_prompts = _by_id(document.get("prompts"), "prompts")
    raw_tools = _by_id(document.get("tools"), "tools")
    raw_memory = _by_id(document.get("memory"), "memory")
    raw_agents = _by_id(document.get("agents"), "agents")

    prompts = {
        prompt_id: _required_str(entry, "template", f"prompt {prompt_id!r}")
        for prompt_id, entry in raw_prompts.items()
    }
    tools = {
        tool_id: ToolSpec(
            id=tool_id,
            name=_required_str(entry, "name", f"tool {tool_id!r}"),
            description=_str(entry.get("description")) or "",
            requires_confirmation=entry.get("requiresConfirmation") is True,
            side_effects=_side_effects(tool_id, entry.get("sideEffects")),
            auth=_policy_expr(entry.get("auth"), f"tool {tool_id!r} auth"),
        )
        for tool_id, entry in raw_tools.items()
    }
    memory = {memory_id: _memory(memory_id, entry) for memory_id, entry in raw_memory.items()}
    guardrails = {
        guardrail_id: _guardrail(guardrail_id, entry, tools)
        for guardrail_id, entry in _by_id(document.get("guardrails"), "guardrails").items()
    }

    fallbacks: dict[str, tuple[str, ...]] = {}
    for model_id, entry in raw_models.items():
        fallbacks[model_id] = tuple(_str_list(entry.get("fallbacks"), f"model {model_id!r}"))

    agents = {
        agent_id: _agent(agent_id, entry, prompts, tools, memory, guardrails)
        for agent_id, entry in raw_agents.items()
    }
    _check_control_targets(agents)

    reachable = _reachable_models(agents, fallbacks)
    models = {model_id: _model(model_id, raw_models[model_id]) for model_id in sorted(reachable)}

    return RuntimeSpec(
        models=models,
        fallbacks={alias: fallbacks.get(alias, ()) for alias in models},
        prompts=prompts,
        tools=tools,
        agents=agents,
        guardrails=guardrails,
    )


def _agent(
    agent_id: str,
    entry: Mapping[str, Any],
    prompts: Mapping[str, str],
    tools: Mapping[str, ToolSpec],
    memory: Mapping[str, MemoryDefinition],
    guardrails: Mapping[str, GuardrailDefinition],
) -> AgentDefinition:
    where = f"agent {agent_id!r}"
    instructions = _str(entry.get("instructions")) or ""
    if instructions not in prompts:
        raise ConfigurationError(
            f"{where} names prompt {instructions!r}, which the IR does not declare; "
            f"declared prompts: {sorted(prompts)}"
        )
    tool_ids = tuple(_str_list(entry.get("tools"), f"{where} tools"))
    missing = sorted(set(tool_ids) - set(tools))
    if missing:
        raise ConfigurationError(f"{where} names undeclared tools: {missing}")
    memory_ids = tuple(_str_list(entry.get("memory"), f"{where} memory"))
    missing_memory = sorted(set(memory_ids) - set(memory))
    if missing_memory:
        raise ConfigurationError(f"{where} names undeclared memory: {missing_memory}")
    guardrail_ids = tuple(_str_list(entry.get("guardrails"), f"{where} guardrails"))
    missing_guardrails = sorted(set(guardrail_ids) - set(guardrails))
    if missing_guardrails:
        raise ConfigurationError(f"{where} names undeclared guardrails: {missing_guardrails}")

    engine = _str(entry.get("engine")) or "native"
    engine_version = _str(entry.get("engineVersion")) or ""
    on_budget = _str(entry.get("onBudgetExhausted")) or "fail"
    if on_budget not in _ON_BUDGET_EXHAUSTED:
        raise ConfigurationError(
            f"{where} has onBudgetExhausted {on_budget!r}; expected one of "
            f"{sorted(_ON_BUDGET_EXHAUSTED)}"
        )
    max_steps = entry.get("maxSteps")
    if not isinstance(max_steps, int) or isinstance(max_steps, bool) or max_steps < 1:
        raise ConfigurationError(f"{where} needs a positive maxSteps, got {max_steps!r}")

    return AgentDefinition(
        id=agent_id,
        name=_str(entry.get("name")) or agent_id,
        instructions=instructions,
        model=_str(entry.get("model")) or "",
        tools=tool_ids,
        memory=tuple(memory[memory_id] for memory_id in memory_ids),
        max_steps=max_steps,
        max_tokens_budget=_optional_int(entry.get("maxTokensBudget")),
        max_cost_budget=_optional_float(entry.get("maxCostBudget")),
        on_budget_exhausted=on_budget,
        handoffs=tuple(_str_list(entry.get("handoffs"), f"{where} handoffs")),
        delegates=tuple(_str_list(entry.get("delegates"), f"{where} delegates")),
        engine=engine,
        engine_version=engine_version,
        approval=_approval(where, entry.get("humanInTheLoop")),
        guardrails=tuple(guardrails[guardrail_id] for guardrail_id in guardrail_ids),
    )


def _guardrail(
    guardrail_id: str,
    entry: Mapping[str, Any],
    tools: Mapping[str, ToolSpec],
) -> GuardrailDefinition:
    where = f"guardrail {guardrail_id!r}"
    stages = tuple(_str_list(entry.get("stages"), f"{where} stages"))
    unknown_stages = sorted(set(stages) - _GUARDRAIL_STAGES)
    if unknown_stages:
        raise ConfigurationError(
            f"{where} names unknown stages {unknown_stages}; expected a subset of "
            f"{sorted(_GUARDRAIL_STAGES)}"
        )
    policies = tuple(_str_list(entry.get("policies"), f"{where} policies"))
    unknown_policies = sorted(set(policies) - _GUARDRAIL_POLICIES)
    if unknown_policies:
        raise ConfigurationError(
            f"{where} names unknown policies {unknown_policies}; expected a subset of "
            f"{sorted(_GUARDRAIL_POLICIES)}"
        )
    action = _str(entry.get("action")) or ""
    if action not in _GUARDRAIL_ACTIONS:
        raise ConfigurationError(
            f"{where} has action {action!r}; expected one of {sorted(_GUARDRAIL_ACTIONS)}"
        )
    redact = tuple(_str_list(entry.get("redact"), f"{where} redact"))
    if action == "redact" and not redact:
        raise ConfigurationError(
            f"{where} uses action 'redact' with no redact fields; a redaction that names "
            "no field cannot redact anything"
        )
    tool_ids = tuple(_str_list(entry.get("tools"), f"{where} tools"))
    missing = sorted(set(tool_ids) - set(tools))
    if missing:
        raise ConfigurationError(f"{where} names undeclared tools: {missing}")

    on_fail = entry.get("onFail")
    if not isinstance(on_fail, Mapping):
        raise ConfigurationError(f"{where} needs an onFail object")
    return GuardrailDefinition(
        id=guardrail_id,
        stages=stages,
        policies=policies,
        action=action,
        redact=redact,
        tools=tool_ids,
        message=_required_str(on_fail, "message", f"{where} onFail"),
        fallback_prompt=_str(on_fail.get("fallbackPrompt")),
        log=on_fail.get("log") is True,
    )


def _side_effects(tool_id: str, raw: Any) -> str:
    if raw is None:
        return "none"
    value = _str(raw)
    if value not in _SIDE_EFFECTS:
        raise ConfigurationError(
            f"tool {tool_id!r} has sideEffects {raw!r}; expected one of {sorted(_SIDE_EFFECTS)}"
        )
    return value


def _policy_expr(raw: Any, where: str) -> Mapping[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise ConfigurationError(
            f"{where} must be a parsed policy object, got {type(raw).__name__}"
        )
    return raw


def _approval(where: str, raw: Any) -> HumanApproval | None:
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise ConfigurationError(f"{where} humanInTheLoop must be an object")
    when = raw.get("when")
    channel = _str(raw.get("channel")) or ""
    if not isinstance(when, Mapping):
        raise ConfigurationError(f"{where} humanInTheLoop needs a parsed 'when' policy")
    if not channel:
        raise ConfigurationError(
            f"{where} declares humanInTheLoop with no channel; without a channel there "
            "is nowhere to ask, so the loop refuses to run it"
        )
    return HumanApproval(when=when, channel=channel)


def _check_control_targets(agents: Mapping[str, AgentDefinition]) -> None:
    for agent in agents.values():
        for field_name, targets in (("handoffs", agent.handoffs), ("delegates", agent.delegates)):
            unknown = sorted(set(targets) - set(agents))
            if unknown:
                raise ConfigurationError(
                    f"agent {agent.id!r} {field_name} undeclared agents: {unknown}"
                )
            if agent.id in targets:
                raise ConfigurationError(
                    f"agent {agent.id!r} {field_name} itself; a control edge must leave the agent"
                )
        both = sorted(set(agent.handoffs) & set(agent.delegates))
        if both:
            raise ConfigurationError(
                f"agent {agent.id!r} lists {both} in both handoffs and delegates; "
                "transfer and delegation are different semantics, so a target is one or the other"
            )


def _reachable_models(
    agents: Mapping[str, AgentDefinition], fallbacks: Mapping[str, tuple[str, ...]]
) -> set[str]:
    reachable: set[str] = set()
    queue = [agent.model for agent in agents.values()]
    while queue:
        alias = queue.pop()
        if alias in reachable:
            continue
        reachable.add(alias)
        queue.extend(fallbacks.get(alias, ()))
    return reachable


def _model(model_id: str, entry: Mapping[str, Any]) -> ModelSpec:
    where = f"model {model_id!r}"
    cost = entry.get("costProfile")
    if not isinstance(cost, Mapping):
        raise ConfigurationError(
            f"{where} has no resolved costProfile; a budget cannot be enforced against "
            "an unpriced model"
        )
    limits = entry.get("limits")
    if not isinstance(limits, Mapping):
        raise ConfigurationError(f"{where} has no limits")
    context_tokens = limits.get("contextTokens")
    if (
        isinstance(context_tokens, bool)
        or not isinstance(context_tokens, int)
        or context_tokens < 1
    ):
        raise ConfigurationError(f"{where} has no positive limits.contextTokens")
    max_output = limits.get("maxOutputTokens")
    if not isinstance(max_output, int) or isinstance(max_output, bool) or max_output < 1:
        # The IR treats an output ceiling as optional; the runtime must still have
        # one, so the context window is the only ceiling the IR guarantees.
        max_output = context_tokens

    capabilities = frozenset(
        _RUNTIME_CAPABILITY[name]
        for name in _str_list(entry.get("capabilities"), f"{where} capabilities")
        if name in _RUNTIME_CAPABILITY
    )
    return ModelSpec(
        name=_required_str(entry, "modelId", where),
        provider=_required_str(entry, "provider", where),
        cost=CostProfile(
            input_per_1k_usd=float(cost.get("inputPerMTok", 0.0)) / 1000.0,
            output_per_1k_usd=float(cost.get("outputPerMTok", 0.0)) / 1000.0,
        ),
        context_window=context_tokens,
        max_output_tokens=max_output,
        capabilities=capabilities,
    )


def _memory(memory_id: str, entry: Mapping[str, Any]) -> MemoryDefinition:
    where = f"memory {memory_id!r}"
    token_budget = entry.get("tokenBudget")
    if not isinstance(token_budget, int) or isinstance(token_budget, bool) or token_budget < 1:
        raise ConfigurationError(f"{where} needs a positive tokenBudget")
    return MemoryDefinition(
        id=memory_id,
        kind=_str(entry.get("kind")) or "buffer",
        scope=_str(entry.get("scope")) or "thread",
        token_budget=token_budget,
        backend=_str(entry.get("backend")),
        store=_str(entry.get("store")),
        summarize_model=_str(entry.get("summarizeModel")),
        ttl=_str(entry.get("ttl")),
        redact=tuple(_str_list(entry.get("redact"), f"{where} redact")),
    )


def _by_id(raw: Any, collection: str) -> dict[str, Mapping[str, Any]]:
    if raw is None:
        return {}
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        raise ConfigurationError(f"IR {collection} must be an array")
    resolved: dict[str, Mapping[str, Any]] = {}
    for entry in raw:
        if not isinstance(entry, Mapping):
            raise ConfigurationError(f"IR {collection} contains a non-object entry")
        entry_id = _str(entry.get("id"))
        if not entry_id:
            raise ConfigurationError(f"IR {collection} contains an entry with no id")
        resolved[entry_id] = entry
    return resolved


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _required_str(entry: Mapping[str, Any], key: str, where: str) -> str:
    value = _str(entry.get(key))
    if not value:
        raise ConfigurationError(f"{where} has no {key!r}")
    return value


def _str_list(value: Any, where: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ConfigurationError(f"{where} must be an array of strings")
    return [item for item in value if isinstance(item, str)]


def _optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _optional_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
