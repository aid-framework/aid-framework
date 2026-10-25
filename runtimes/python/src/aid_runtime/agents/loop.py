"""The native agent engine: one loop, three ways to leave it.

The loop is a model call, its tool calls, the observations, repeat -- until the
model answers without a tool call, until ``maxSteps`` is spent, until a budget is
crossed, or until a human is needed. It consumes a :class:`RuntimeSpec` (the IR
seam in ``agents.ir``) and calls models through :class:`ModelGateway`, so fallback,
cost accounting, and tracing behave exactly as they do for a pipeline step.

Two control edges, and the difference is not cosmetic:

**transfer** -- IR ``handoffs``. Control *moves*. The caller does not resume; the
target owns the rest of the turn and its answer is the run's answer. The target
inherits the conversation but not the caller's instructions: a system prompt
belongs to an agent, not to a transcript. The runtime primitive is
:meth:`AgentRuntime._transfer`, and it never returns to the caller.

**delegate** -- IR ``delegates`` (Deep Agents ``subagents``). Control is *lent*.
The delegate gets an isolated context -- its own system prompt and the one message
it was handed, nothing else -- and returns exactly one observation. The caller
resumes, sees that observation as a tool result, and authors the final answer. The
runtime primitive is :meth:`AgentRuntime._delegate`.

So the observable difference is who produces the final answer, and whose transcript
contains the other's messages: after a transfer the answer is the target's and the
caller's steps are a prefix of the target's run; after a delegate the answer is the
caller's and the delegate's transcript is a separate, closed conversation.

Budgets are ratified decision D1: crossing one is a hard failure. An agent that
declares ``onBudgetExhausted: degrade`` instead steps **one** rung down its declared
alias ladder, **once**, and both the step record and the ledger show the cheaper
alias. It is never a retry loop: a degraded frame that still does not fit fails.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from opentelemetry.trace import Span, Tracer

from aid_runtime.agents.ir import (
    AgentDefinition,
    MemoryDefinition,
    RuntimeSpec,
    ToolSpec,
    from_ir,
)
from aid_runtime.agents.memory import (
    InProcessMemoryStore,
    MemoryStore,
    ThreadMemory,
    check_memory_supported,
    render_context,
)
from aid_runtime.agents.policy import Principal, evaluate_policy, policy_source
from aid_runtime.agents.state import (
    AgentCheckpoint,
    HumanDecision,
    RunResult,
    RunStatus,
    StepKind,
    StepRecord,
)
from aid_runtime.cost import Budget, CostLedger, LedgerEntry
from aid_runtime.errors import (
    AgentBudgetDegradedError,
    AgentTransferCycleError,
    BudgetExceededError,
    CapabilityMismatchError,
    ConfigurationError,
    FeatureDeferredError,
)
from aid_runtime.gateway import ModelGateway
from aid_runtime.providers.base import Provider
from aid_runtime.tools import Tool, ToolExecutor
from aid_runtime.tracing import agent_span, record_attributes, record_hitl
from aid_runtime.types import (
    Capability,
    CompletionRequest,
    CompletionResponse,
    GenerationResult,
    Message,
    TokenUsage,
    ToolCall,
    ToolDefinition,
)

__all__ = ["AgentRuntime"]

#: Namespacing for the control tools. A model cannot transfer by emitting prose,
#: and it cannot call a control tool the agent's IR did not declare.
TRANSFER_PREFIX = "transfer_to_"
DELEGATE_PREFIX = "delegate_to_"

#: The one argument a control tool takes: what the other agent needs to know.
CONTROL_ARGUMENT = "message"

_NATIVE = "native"
_DEGRADE = "degrade"
_THREAD = "thread"
_GLOBAL = "global"
_IN_PROCESS = "in-process"
_RESTORED_ALIAS = "restored"
_TOOL_CONFIRMATION = "tool-confirmation"
_REJECTED = "rejected by the human approver"


@dataclass(frozen=True, slots=True)
class _MemoryState:
    """The memory context one agent turn resolved, and what it measured."""

    thread: ThreadMemory | None = None
    context: str = ""
    scopes: tuple[str, ...] = ()
    entries: int = 0
    tokens: int = 0


@dataclass(slots=True)
class _Frame:
    """One agent's turn in progress: its own transcript, budget anchors, and steps."""

    agent: AgentDefinition
    messages: list[Message]
    alias: str
    path: tuple[str, ...]
    step: int = 0
    degraded: bool = False
    memory: _MemoryState = field(default_factory=_MemoryState)
    memory_key: str = ""
    cost_anchor: float = 0.0
    token_anchor: int = 0
    steps: list[StepRecord] = field(default_factory=list)
    resumed_decision: HumanDecision | None = None
    resumed_channel: str = ""


@dataclass(slots=True)
class _Outcome:
    """What a frame decided, before the run's totals are stamped on it."""

    status: RunStatus
    agent_id: str
    answer: str = ""
    steps: list[StepRecord] = field(default_factory=list)
    path: tuple[str, ...] = ()
    checkpoint: AgentCheckpoint | None = None


class AgentRuntime:
    """Runs the IR's agents on the native engine."""

    def __init__(
        self,
        spec: RuntimeSpec,
        gateway: ModelGateway,
        *,
        tools: Iterable[Tool] = (),
        stores: Mapping[str, MemoryStore] | None = None,
        memory_store: MemoryStore | None = None,
        tracer: Tracer | None = None,
    ) -> None:
        self._spec = spec
        self._gateway = gateway
        self._executor = ToolExecutor(tools)
        self._stores = dict(stores or {})
        self._default_store: MemoryStore = (
            memory_store if memory_store is not None else InProcessMemoryStore()
        )
        self._tracer = tracer
        self._tools_by_name: dict[str, ToolSpec] = {
            definition.name: definition for definition in spec.tools.values()
        }
        self._check_declarations()

    @classmethod
    def from_ir(
        cls,
        document: Mapping[str, Any],
        *,
        providers: Mapping[str, Provider],
        tools: Iterable[Tool] = (),
        stores: Mapping[str, MemoryStore] | None = None,
        memory_store: MemoryStore | None = None,
        ledger: CostLedger | None = None,
        budget: Budget | None = None,
        tracer: Tracer | None = None,
    ) -> AgentRuntime:
        """Build a runtime from an emitted IR document."""
        spec = from_ir(document)
        gateway = ModelGateway(providers, spec.models, ledger=ledger, budget=budget)
        return cls(
            spec,
            gateway,
            tools=tools,
            stores=stores,
            memory_store=memory_store,
            tracer=tracer,
        )

    @property
    def spec(self) -> RuntimeSpec:
        return self._spec

    @property
    def gateway(self) -> ModelGateway:
        return self._gateway

    async def run(
        self,
        agent_id: str,
        text: str,
        *,
        principal: Principal | None = None,
        memory_key: str | None = None,
        conversation: Sequence[Message] = (),
    ) -> RunResult:
        """Run ``agent_id`` to a stop condition on one user message."""
        agent = self._spec.agent(agent_id)
        self._require_engine(agent)
        key = memory_key or agent.id
        frame = await self._open(
            agent,
            [
                Message.system(self._spec.system_prompt(agent)),
                *conversation,
                Message.user(text),
            ],
            path=(agent.id,),
            memory_key=key,
        )
        start_cost = self._gateway.ledger.cost_usd
        start_tokens = self._gateway.ledger.total_tokens
        outcome = await self._drive(
            frame,
            principal=principal if principal is not None else Principal(),
            memory_key=key,
        )
        return self._wrap(outcome, start_cost, start_tokens)

    async def resume(
        self,
        checkpoint: AgentCheckpoint,
        decision: HumanDecision | str,
        *,
        principal: Principal | None = None,
    ) -> RunResult:
        """Continue a paused run from its checkpoint, with a human's answer."""
        resolved = HumanDecision(decision)
        self._restore_ledger(checkpoint)
        start_cost = self._gateway.ledger.cost_usd
        start_tokens = self._gateway.ledger.total_tokens
        outcome = await self._resume(
            checkpoint,
            resolved,
            principal if principal is not None else Principal(),
        )
        return self._wrap(outcome, start_cost, start_tokens)

    async def _resume(
        self,
        checkpoint: AgentCheckpoint,
        decision: HumanDecision,
        principal: Principal,
    ) -> _Outcome:
        if checkpoint.resume_kind == "delegate":
            raise ConfigurationError(
                f"the checkpoint belongs to agent {checkpoint.agent_id!r}, which was waiting "
                "inside a delegate; resume the checkpoint that carries the caller link"
            )
        agent = self._spec.agent(checkpoint.agent_id)
        self._require_engine(agent)
        frame = await self._frame_from(checkpoint)
        frame.resumed_decision = decision
        frame.resumed_channel = checkpoint.channel
        if decision is HumanDecision.APPROVE:
            frame.messages.extend(await self._observe(checkpoint.calls))
        else:
            frame.messages.extend(
                Message.tool(call.id, _REJECTED, name=call.name) for call in checkpoint.calls
            )
        outcome = await self._drive(frame, principal=principal, memory_key=checkpoint.memory_key)
        if checkpoint.caller is None:
            return outcome
        if outcome.status is RunStatus.PAUSED and outcome.checkpoint is not None:
            # The delegate paused again; the caller is still the one waiting, and the
            # caller link has to survive the second pause or the run cannot continue.
            outcome.checkpoint = outcome.checkpoint.model_copy(update={"caller": checkpoint.caller})
            return outcome
        return await self._resume_caller(checkpoint.caller, outcome, principal=principal)

    async def _resume_caller(
        self,
        caller: AgentCheckpoint,
        inner: _Outcome,
        *,
        principal: Principal,
    ) -> _Outcome:
        frame = await self._frame_from(caller)
        call = caller.calls[0]
        frame.messages.append(Message.tool(call.id, inner.answer, name=call.name))
        frame.steps.extend(inner.steps)
        return await self._drive(frame, principal=principal, memory_key=caller.memory_key)

    async def _drive(
        self,
        frame: _Frame,
        *,
        principal: Principal,
        memory_key: str,
    ) -> _Outcome:
        budget = self._budget(frame)
        with agent_span(
            agent_id=frame.agent.id, engine=frame.agent.engine, tracer=self._tracer
        ) as span:
            record_attributes(
                span,
                memory_scope=",".join(frame.memory.scopes) or None,
                memory_entries=frame.memory.entries or None,
                memory_tokens=frame.memory.tokens or None,
            )
            if frame.resumed_decision is not None:
                record_hitl(
                    span,
                    phase="resume",
                    channel=frame.resumed_channel,
                    decision=frame.resumed_decision.value,
                    step=frame.step,
                )
            return await self._run_loop(
                frame, budget=budget, principal=principal, memory_key=memory_key, span=span
            )

    async def _run_loop(
        self,
        frame: _Frame,
        *,
        budget: Budget | None,
        principal: Principal,
        memory_key: str,
        span: Span,
    ) -> _Outcome:
        agent = frame.agent
        while True:
            if frame.step >= agent.max_steps:
                self._record_status(span, "max-steps", frame)
                return self._outcome(RunStatus.MAX_STEPS, frame)

            request = self._request(frame)
            alias, degraded_from = self._route(frame, request, budget, span)
            generation = await self._generate(agent, alias, request, budget=budget)
            frame.step += 1
            record = StepRecord(
                index=frame.step,
                agent_id=agent.id,
                kind=StepKind.ANSWER,
                alias=generation.alias,
                model=generation.response.model,
                cost_usd=generation.cost_usd,
                total_tokens=generation.usage.total_tokens,
                degraded_from=degraded_from,
            )
            frame.steps.append(record)
            response = generation.response

            if not response.tool_calls:
                frame.messages.append(Message.assistant(response.text))
                await self._remember(agent, response.text, memory_key)
                self._record_status(span, "completed", frame)
                return self._outcome(RunStatus.COMPLETED, frame, answer=response.text)

            control = self._control_call(response.tool_calls)
            if control is not None:
                moved = await self._control(
                    frame,
                    record,
                    control,
                    response,
                    principal=principal,
                    memory_key=memory_key,
                    budget=budget,
                    span=span,
                )
                if moved is not None:
                    return moved
                continue

            record.kind = StepKind.TOOLS
            record.tool_names = tuple(call.name for call in response.tool_calls)
            frame.messages.append(Message.assistant_tool_calls(response.text, response.tool_calls))
            if self._needs_approval(agent, response.tool_calls, principal):
                checkpoint = self._checkpoint(frame, response.tool_calls, memory_key)
                record_hitl(
                    span,
                    phase="pause",
                    channel=checkpoint.channel,
                    when=policy_source(agent.approval.when) if agent.approval else None,
                    step=frame.step,
                )
                self._record_status(span, "paused", frame)
                return _Outcome(
                    status=RunStatus.PAUSED,
                    agent_id=agent.id,
                    steps=frame.steps,
                    path=frame.path,
                    checkpoint=checkpoint,
                )

            frame.messages.extend(await self._observe(response.tool_calls))

    async def _control(
        self,
        frame: _Frame,
        record: StepRecord,
        call: ToolCall,
        response: CompletionResponse,
        *,
        principal: Principal,
        memory_key: str,
        budget: Budget | None,
        span: Span,
    ) -> _Outcome | None:
        """Act on a control call. ``None`` means the caller keeps control."""
        transferring = call.name.startswith(TRANSFER_PREFIX)
        prefix = TRANSFER_PREFIX if transferring else DELEGATE_PREFIX
        target_id = call.name[len(prefix) :]
        declared = frame.agent.handoffs if transferring else frame.agent.delegates
        if target_id not in declared:
            raise ConfigurationError(
                f"agent {frame.agent.id!r} called control tool {call.name!r}, but does not "
                f"declare it; declared handoffs {list(frame.agent.handoffs)} and "
                f"delegates {list(frame.agent.delegates)}"
            )
        if target_id in frame.path:
            raise AgentTransferCycleError([*frame.path, target_id])
        message = _control_message(call, response)
        if transferring:
            record.kind = StepKind.TRANSFER
            record.target = target_id
            record_attributes(span, agent_transfer_to=target_id)
            return await self._transfer(
                frame, target_id, message, principal=principal, memory_key=memory_key
            )
        record.kind = StepKind.DELEGATE
        record.target = target_id
        record_attributes(span, agent_delegate_to=target_id)
        return await self._delegate(
            frame,
            call,
            response,
            target_id,
            message,
            principal=principal,
            memory_key=memory_key,
            budget=budget,
            span=span,
        )

    async def _transfer(
        self,
        frame: _Frame,
        target_id: str,
        message: str,
        *,
        principal: Principal,
        memory_key: str,
    ) -> _Outcome:
        """Move control to another agent. The caller does not come back.

        The target inherits the conversation -- every message except the caller's
        system prompt, which is the caller's instructions and not the target's.
        """
        target = self._spec.agent(target_id)
        frame.messages.append(Message.assistant(message))
        history = [item for item in frame.messages if item.role != "system"]
        target_frame = await self._open(
            target,
            [Message.system(self._spec.system_prompt(target)), *history],
            path=(*frame.path, target.id),
            memory_key=memory_key,
        )
        outcome = await self._drive(target_frame, principal=principal, memory_key=memory_key)
        outcome.steps = [*frame.steps, *outcome.steps]
        outcome.path = (*frame.path, target.id)
        return outcome

    async def _delegate(
        self,
        frame: _Frame,
        call: ToolCall,
        response: CompletionResponse,
        target_id: str,
        message: str,
        *,
        principal: Principal,
        memory_key: str,
        budget: Budget | None,
        span: Span,
    ) -> _Outcome | None:
        """Lend control to another agent, then continue as the caller.

        The delegate's context is isolated: its own system prompt and the single
        message it was handed. Nothing else of the caller's transcript is visible,
        which is what makes its result one observation rather than a continuation.
        """
        target = self._spec.agent(target_id)
        frame.messages.append(Message.assistant_tool_calls(response.text, response.tool_calls))
        delegate_frame = await self._open(
            target,
            [Message.system(self._spec.system_prompt(target)), Message.user(message)],
            path=(*frame.path, target.id),
            memory_key=memory_key,
        )
        inner = await self._drive(delegate_frame, principal=principal, memory_key=memory_key)
        if inner.status is RunStatus.PAUSED:
            inner.steps = [*frame.steps, *inner.steps]
            if inner.checkpoint is not None:
                caller = self._checkpoint(frame, (call,), memory_key).model_copy(
                    update={"resume_kind": "delegate", "channel": ""}
                )
                inner.checkpoint = inner.checkpoint.model_copy(update={"caller": caller})
            return inner
        if inner.status is not RunStatus.COMPLETED:
            # The delegate ran out of steps or budget, so it has no result to hand
            # back; the caller cannot borrow an answer that was never produced.
            inner.steps = [*frame.steps, *inner.steps]
            return inner
        frame.steps.extend(inner.steps)
        frame.messages.append(Message.tool(call.id, inner.answer, name=call.name))
        return await self._run_loop(
            frame, budget=budget, principal=principal, memory_key=memory_key, span=span
        )

    async def _observe(self, calls: Sequence[ToolCall]) -> list[Message]:
        """Turn calls into observations, in the order the model asked for them.

        A name this agent cannot call comes back as a tool error instead of
        raising: the model composed the call, so the model is the party that can
        correct it, exactly as for bad arguments. A missing *registration* is a
        different failure and is refused when the runtime is built, where the
        application can fix it.
        """
        known = [call for call in calls if call.name in self._executor.names]
        executed = {result.call_id: result for result in await self._executor.execute_all(known)}
        observations: list[Message] = []
        for call in calls:
            result = executed.get(call.id)
            if result is None:
                observations.append(
                    Message.tool(
                        call.id,
                        f"error: this agent has no tool named {call.name!r}",
                        name=call.name,
                    )
                )
                continue
            observations.append(Message.tool(result.call_id, result.content, name=result.name))
        return observations

    def _request(self, frame: _Frame) -> CompletionRequest:
        messages = tuple(frame.messages)
        if frame.memory.thread is not None:
            messages = frame.memory.thread.trim(messages)
        if frame.memory.context:
            messages = (messages[0], Message.system(frame.memory.context), *messages[1:])
        return CompletionRequest(messages=messages, tools=self._tool_definitions(frame.agent))

    def _tool_definitions(self, agent: AgentDefinition) -> tuple[ToolDefinition, ...]:
        definitions = [
            self._executor.definition(self._spec.tools[tool_id].name) for tool_id in agent.tools
        ]
        for target in agent.handoffs:
            definitions.append(_control_definition(TRANSFER_PREFIX, target))
        for target in agent.delegates:
            definitions.append(_control_definition(DELEGATE_PREFIX, target))
        return tuple(definitions)

    async def _generate(
        self,
        agent: AgentDefinition,
        alias: str,
        request: CompletionRequest,
        *,
        budget: Budget | None,
    ) -> GenerationResult:
        """Call the model, refusing a silent downgrade to one that cannot tool-call.

        The pinned model must advertise ``tool-calling`` when the agent has tools or
        control edges. A gateway fallback is chosen for a provider failure without
        re-negotiating capabilities, so the answer's alias is checked too: an agent
        that cannot call a tool would otherwise answer from memory and look fine.

        The agent's ceiling goes to the gateway as the call's budget, so a breach is
        the gateway's own :class:`~aid_runtime.errors.BudgetExceededError` -- hard
        failure by default, with no second accounting path in the loop.
        """
        required = frozenset(
            {Capability.TOOL_CALLING} if agent.tools or agent.has_control_tools else set()
        )
        if required:
            self._gateway.require(alias, required)
        generation = await self._gateway.generate(
            alias, request, fallbacks=self._spec.fallbacks_for(alias), budget=budget
        )
        if required and not self._gateway.resolve(generation.alias).supports(required):
            raise CapabilityMismatchError(
                generation.alias, sorted(capability.value for capability in required)
            )
        return generation

    def _route(
        self,
        frame: _Frame,
        request: CompletionRequest,
        budget: Budget | None,
        span: Span,
    ) -> tuple[str, str | None]:
        """Pick the alias for this call, stepping down the ladder at most once."""
        agent = frame.agent
        if agent.on_budget_exhausted != _DEGRADE or frame.degraded:
            return frame.alias, None
        # Degrade steps down a *price* ladder, so it needs a dollar ceiling to step
        # down from. A token-only ceiling cannot be made affordable by switching
        # alias, and the gate refuses degrade without maxCostBudget, so there is
        # nothing to route here. Returning keeps that hard failure with the ledger.
        if budget is None or budget.max_usd is None:
            return frame.alias, None
        if self._gateway.fits(frame.alias, request, budget):
            return frame.alias, None
        cheaper = self._spec.cheaper_fallback(frame.alias)
        if cheaper is None:
            raise AgentBudgetDegradedError(
                f"agent {agent.id!r} declares onBudgetExhausted: degrade, but alias "
                f"{frame.alias!r} declares no cheaper fallback; ir/agents-budget-degrade "
                "rejects this at build time, so this IR did not come through the gate"
            )
        if not self._gateway.fits(cheaper, request, budget):
            # One rung was available and is still too dear: the budget is exhausted.
            raise BudgetExceededError(budget.scope, budget.max_usd, self._gateway.ledger.cost_usd)
        previous = frame.alias
        frame.alias = cheaper
        frame.degraded = True
        record_attributes(
            span, agent_budget_degraded=True, agent_budget_from=previous, agent_budget_to=cheaper
        )
        return cheaper, previous

    def _budget(self, frame: _Frame) -> Budget | None:
        """The agent's ceiling, expressed as absolute spend for one ledger.

        The ledger is shared by the whole run, so a per-agent ceiling is anchored at
        the spend the agent started from. That keeps a single accounting path
        instead of a second ledger per agent, and it is what lets a cheaper alias
        make the *same* ceiling affordable again.
        """
        agent = frame.agent
        if agent.max_cost_budget is None and agent.max_tokens_budget is None:
            return None
        max_usd = (
            None
            if agent.max_cost_budget is None
            else round(frame.cost_anchor + agent.max_cost_budget, 6)
        )
        max_tokens = (
            None
            if agent.max_tokens_budget is None
            else frame.token_anchor + agent.max_tokens_budget
        )
        return Budget(max_usd=max_usd, max_total_tokens=max_tokens, scope=f"agent:{agent.id}")

    def _control_call(self, calls: Sequence[ToolCall]) -> ToolCall | None:
        controls = [
            call for call in calls if call.name.startswith((TRANSFER_PREFIX, DELEGATE_PREFIX))
        ]
        if not controls:
            return None
        if len(calls) > 1:
            raise ConfigurationError(
                "a control call must be the only call in its step, because it changes who "
                f"owns the rest of the turn; got {[call.name for call in calls]}"
            )
        return controls[0]

    def _needs_approval(
        self, agent: AgentDefinition, calls: Sequence[ToolCall], principal: Principal
    ) -> bool:
        """Whether a person must answer before these calls run.

        Two triggers, both from the IR: the tool declares ``requiresConfirmation``,
        or the agent's ``humanInTheLoop.when`` policy holds for this principal. The
        policy is evaluated against the caller, never against a step counter, which
        is why a pause cannot fire on "step 3" unless the IR's policy says so.
        """
        if any(
            self._tools_by_name[call.name].requires_confirmation
            for call in calls
            if call.name in self._tools_by_name
        ):
            return True
        return agent.approval is not None and evaluate_policy(agent.approval.when, principal)

    def _checkpoint(
        self, frame: _Frame, calls: Sequence[ToolCall], memory_key: str
    ) -> AgentCheckpoint:
        approval = frame.agent.approval
        return AgentCheckpoint(
            agent_id=frame.agent.id,
            step=frame.step,
            messages=tuple(frame.messages),
            steps=tuple(frame.steps),
            calls=tuple(calls),
            channel=approval.channel if approval is not None else _TOOL_CONFIRMATION,
            when=dict(approval.when) if approval is not None else {},
            cost_anchor_usd=frame.cost_anchor,
            token_anchor=frame.token_anchor,
            spent_usd=self._gateway.ledger.cost_usd,
            spent_tokens=self._gateway.ledger.total_tokens,
            degraded=frame.degraded,
            alias=frame.alias,
            path=frame.path,
            memory_key=memory_key,
        )

    def _restore_ledger(self, checkpoint: AgentCheckpoint) -> None:
        """Carry a pause's spend into this process's ledger before resuming.

        A resume in a fresh process starts with an empty ledger, which would hand
        the agent a ceiling it has already partly spent. The restored amount is a
        real ledger entry under a distinct alias, so the spend stays auditable
        instead of becoming a number the loop quietly remembers.
        """
        ledger = self._gateway.ledger
        missing_usd = round(checkpoint.spent_usd - ledger.cost_usd, 6)
        missing_tokens = checkpoint.spent_tokens - ledger.total_tokens
        if missing_usd <= 0 and missing_tokens <= 0:
            return
        ledger.charge(
            None,
            LedgerEntry(
                alias=_RESTORED_ALIAS,
                model=_RESTORED_ALIAS,
                provider=_RESTORED_ALIAS,
                usage=TokenUsage(input_tokens=max(missing_tokens, 0), output_tokens=0),
                cost_usd=max(missing_usd, 0.0),
            ),
        )

    async def _open(
        self,
        agent: AgentDefinition,
        messages: Sequence[Message],
        *,
        path: tuple[str, ...],
        memory_key: str,
    ) -> _Frame:
        self._require_engine(agent)
        memory = await self._memory_state(agent, memory_key)
        ledger = self._gateway.ledger
        return _Frame(
            agent=agent,
            messages=list(messages),
            alias=agent.model,
            path=path,
            memory=memory,
            memory_key=memory_key,
            cost_anchor=ledger.cost_usd,
            token_anchor=ledger.total_tokens,
        )

    async def _frame_from(self, checkpoint: AgentCheckpoint) -> _Frame:
        agent = self._spec.agent(checkpoint.agent_id)
        memory = await self._memory_state(agent, checkpoint.memory_key)
        return _Frame(
            agent=agent,
            messages=list(checkpoint.messages),
            alias=checkpoint.alias or agent.model,
            path=checkpoint.path,
            step=checkpoint.step,
            degraded=checkpoint.degraded,
            memory=memory,
            memory_key=checkpoint.memory_key,
            cost_anchor=checkpoint.cost_anchor_usd,
            token_anchor=checkpoint.token_anchor,
            steps=list(checkpoint.steps),
        )

    async def _memory_state(self, agent: AgentDefinition, memory_key: str) -> _MemoryState:
        thread: ThreadMemory | None = None
        blocks: list[str] = []
        scopes: list[str] = []
        entries = 0
        tokens = 0
        for definition in agent.memory:
            check_memory_supported(
                memory_id=definition.id,
                kind=definition.kind,
                summarize_model=definition.summarize_model,
                ttl=definition.ttl,
                redact=definition.redact,
            )
            scopes.append(definition.scope)
            if definition.scope == _THREAD:
                if thread is None or definition.token_budget < _budget_of(thread):
                    thread = ThreadMemory(definition.token_budget)
                continue
            values = await self._store_for(definition).read(
                scope=definition.scope, key=_storage_key(definition, memory_key)
            )
            text, used = render_context(values, definition.token_budget)
            if text:
                blocks.append(f"[{definition.id}]\n{text}")
            entries += len(values)
            tokens += used
        return _MemoryState(
            thread=thread,
            context="\n\n".join(blocks),
            scopes=tuple(scopes),
            entries=entries,
            tokens=tokens,
        )

    async def _remember(self, agent: AgentDefinition, answer: str, memory_key: str) -> None:
        """Record the answer in every memory that outlives the run."""
        if not answer:
            return
        for definition in agent.memory:
            if definition.scope == _THREAD:
                continue
            await self._store_for(definition).append(
                scope=definition.scope,
                key=_storage_key(definition, memory_key),
                value=answer,
            )

    def _store_for(self, definition: MemoryDefinition) -> MemoryStore:
        backend = definition.backend
        if backend is None or backend == _IN_PROCESS:
            return self._default_store
        try:
            return self._stores[backend]
        except KeyError:
            raise ConfigurationError(
                f"memory {definition.id!r} names backend {backend!r}, which is not "
                f"registered here; registered stores: {sorted(self._stores) or '<none>'}"
            ) from None

    def _check_declarations(self) -> None:
        for agent in self._spec.agents.values():
            declared = {self._spec.tools[tool_id].name for tool_id in agent.tools}
            missing = sorted(declared - set(self._executor.names))
            if missing:
                raise ConfigurationError(
                    f"agent {agent.id!r} declares tools that are not registered on this "
                    f"runtime: {missing}; registered tools: {list(self._executor.names)}"
                )
            control = {TRANSFER_PREFIX + target for target in agent.handoffs}
            control |= {DELEGATE_PREFIX + target for target in agent.delegates}
            shadowed = sorted(control & declared)
            if shadowed:
                raise ConfigurationError(
                    f"agent {agent.id!r} declares a tool named like a control tool "
                    f"({shadowed}); transfer and delegation would be silently shadowed"
                )

    @staticmethod
    def _require_engine(agent: AgentDefinition) -> None:
        if agent.engine != _NATIVE:
            raise FeatureDeferredError(
                f"agent {agent.id!r} declares engine {agent.engine!r}; L2 implements the "
                "native engine only, and the deepagents backend is L4"
            )

    @staticmethod
    def _record_status(span: Span, status: str, frame: _Frame) -> None:
        record_attributes(span, agent_status=status, agent_steps=frame.step)

    @staticmethod
    def _outcome(status: RunStatus, frame: _Frame, *, answer: str = "") -> _Outcome:
        return _Outcome(
            status=status,
            agent_id=frame.agent.id,
            answer=answer,
            steps=frame.steps,
            path=frame.path,
        )

    def _wrap(self, outcome: _Outcome, start_cost: float, start_tokens: int) -> RunResult:
        ledger = self._gateway.ledger
        return RunResult(
            status=outcome.status,
            agent_id=outcome.agent_id,
            answer=outcome.answer,
            steps=tuple(outcome.steps),
            path=outcome.path,
            cost_usd=round(max(ledger.cost_usd - start_cost, 0.0), 6),
            total_tokens=max(ledger.total_tokens - start_tokens, 0),
            checkpoint=outcome.checkpoint,
        )


def _budget_of(thread: ThreadMemory) -> int:
    return thread.token_budget if thread.token_budget is not None else 0


def _storage_key(definition: MemoryDefinition, memory_key: str) -> str:
    """Global scope is shared by every caller; user scope is per key."""
    if definition.scope == _GLOBAL:
        return definition.id
    return f"{memory_key}:{definition.id}"


def _control_message(call: ToolCall, response: CompletionResponse) -> str:
    raw = call.arguments.get(CONTROL_ARGUMENT)
    if isinstance(raw, str) and raw:
        return raw
    return response.text or f"control passed to {call.name}"


def _control_definition(prefix: str, target: str) -> ToolDefinition:
    transferring = prefix == TRANSFER_PREFIX
    description = (
        f"Transfer the conversation to agent {target!r}. Control moves: you will not "
        "answer again, and the other agent produces the final answer."
        if transferring
        else (
            f"Delegate a self-contained task to agent {target!r}. Control returns to you "
            "with its result as an observation; you still produce the final answer."
        )
    )
    return ToolDefinition(
        name=f"{prefix}{target}",
        description=description,
        parameters={
            "type": "object",
            "properties": {
                CONTROL_ARGUMENT: {
                    "type": "string",
                    "description": (
                        "Where to take the conversation from here."
                        if transferring
                        else "The whole task; the other agent cannot see this conversation."
                    ),
                }
            },
            "required": [CONTROL_ARGUMENT],
            "additionalProperties": False,
        },
    )
