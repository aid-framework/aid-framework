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

from aid_runtime.agents.engine import DEEPAGENTS, check_engine
from aid_runtime.agents.guardrails import (
    ACTION_BLOCK,
    ACTION_ESCALATE,
    ACTION_REDACT,
    GuardrailEngine,
    GuardrailEscalation,
    GuardrailRecord,
    GuardrailVerdict,
)
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
from aid_runtime.agents.policy import (
    Principal,
    evaluate_policy,
    policy_source,
)
from aid_runtime.agents.state import (
    AgentCheckpoint,
    HumanDecision,
    RunResult,
    RunStatus,
    StepKind,
    StepRecord,
)
from aid_runtime.concurrency import ConcurrencyLimiter
from aid_runtime.cost import Budget, CostLedger, LedgerEntry
from aid_runtime.errors import (
    AgentBudgetDegradedError,
    AgentTransferCycleError,
    BudgetExceededError,
    CapabilityMismatchError,
    ConfigurationError,
    GuardrailBlockedError,
    PolicyEvaluationError,
    ToolPermissionError,
)
from aid_runtime.gateway import ModelGateway
from aid_runtime.providers.base import Provider
from aid_runtime.tools import Tool, ToolExecutor
from aid_runtime.tracing import agent_span, record_attributes, record_guardrail, record_hitl
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

_DEGRADE = "degrade"
_THREAD = "thread"
_GLOBAL = "global"
_IN_PROCESS = "in-process"
_RESTORED_ALIAS = "restored"
_TOOL_CONFIRMATION = "tool-confirmation"
_GUARDRAIL_CHANNEL = "guardrail"
_GUARDRAIL_INPUT = "input"
_GUARDRAIL_OUTPUT = "output"
_GUARDRAIL_TOOL = "tool-call"
#: Side effects that must be explicitly granted. ``read`` and ``none`` are not in
#: here on purpose: permissioning exists to gate effects, and gating reads would
#: make every hostile tool the interesting one.
_SIDE_EFFECTING = frozenset({"write", "destructive"})
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
    # `input` runs once per frame, on the message the frame started from. A
    # transferred target re-checks the conversation it inherited (its guardrails are
    # its own), while a resumed frame does not: the checkpoint only exists because
    # the input stage already ran.
    input_checked: bool = False
    guardrails: list[GuardrailRecord] = field(default_factory=list)


@dataclass(slots=True)
class _Outcome:
    """What a frame decided, before the run's totals are stamped on it."""

    status: RunStatus
    agent_id: str
    answer: str = ""
    steps: list[StepRecord] = field(default_factory=list)
    path: tuple[str, ...] = ()
    checkpoint: AgentCheckpoint | None = None
    guardrails: tuple[GuardrailRecord, ...] = ()


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
        limiter: ConcurrencyLimiter | None = None,
    ) -> None:
        self._spec = spec
        self._gateway = gateway
        self._executor = ToolExecutor(tools, limiter=limiter)
        self._stores = dict(stores or {})
        self._default_store: MemoryStore = (
            memory_store if memory_store is not None else InProcessMemoryStore()
        )
        self._tracer = tracer
        self._guardrails = GuardrailEngine(spec.guardrails)
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
        """Build a runtime from an emitted IR document.

        The IR's ``deployments[].concurrency`` becomes one limiter shared by the
        gateway and the tool executor, so model calls, tool calls, and delegation
        all draw from the same budget rather than running two independent pools.
        """
        spec = from_ir(document)
        limiter = ConcurrencyLimiter(spec.concurrency) if spec.concurrency is not None else None
        gateway = ModelGateway(
            providers, spec.models, ledger=ledger, budget=budget, limiter=limiter
        )
        return cls(
            spec,
            gateway,
            tools=tools,
            stores=stores,
            memory_store=memory_store,
            tracer=tracer,
            limiter=limiter,
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
        escalation = checkpoint.escalation
        if decision is HumanDecision.APPROVE:
            if escalation is not None and escalation.stage == _GUARDRAIL_OUTPUT:
                # The model already produced this answer and a person released it;
                # re-generating would spend tokens to answer the same question and
                # could produce a different answer than the one that was approved.
                answer = escalation.text
                frame.messages.append(Message.assistant(answer))
                await self._remember(agent, answer, checkpoint.memory_key)
                return self._guardrail_completed(frame, answer)
            frame.messages.extend(await self._observe(agent, checkpoint.calls, principal))
        elif escalation is not None:
            # A person declined to release what the guardrail flagged. That is a
            # decision, not an error, and the run stops here with the guardrail's
            # own message as the answer rather than inventing one.
            return _Outcome(
                status=RunStatus.BLOCKED,
                agent_id=agent.id,
                answer=escalation.message,
                steps=frame.steps,
                path=frame.path,
                guardrails=tuple(frame.guardrails),
            )
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
        frame.guardrails.extend(inner.guardrails)
        return await self._drive(frame, principal=principal, memory_key=caller.memory_key)

    def _guardrail_completed(self, frame: _Frame, answer: str) -> _Outcome:
        """Complete a frame after an approved escalation released its answer."""
        return _Outcome(
            status=RunStatus.COMPLETED,
            agent_id=frame.agent.id,
            answer=answer,
            steps=frame.steps,
            path=frame.path,
            guardrails=tuple(frame.guardrails),
        )

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
            return await self._run(
                frame, budget=budget, principal=principal, memory_key=memory_key, span=span
            )

    async def _run(
        self,
        frame: _Frame,
        *,
        budget: Budget | None,
        principal: Principal,
        memory_key: str,
        span: Span,
    ) -> _Outcome:
        """Drive the frame on the engine its agent declared.

        The native loop is the default and is unchanged. ``deepagents`` is a backend
        selected per agent: the frame, checkpoint, budget and guardrail engine are
        shared, so only the drive function differs. The import is deferred because the
        harness is an optional extra -- an IR that never declares the engine must not
        require it to be installed.
        """
        if frame.agent.engine == DEEPAGENTS:
            from aid_runtime.agents.deep_agents import DeepAgentsEngine

            return await DeepAgentsEngine(self).drive(
                frame, budget=budget, principal=principal, memory_key=memory_key, span=span
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

            if not frame.input_checked:
                frame.input_checked = True
                paused = self._guardrail_text(
                    _GUARDRAIL_INPUT, frame, memory_key, span=span, rewrite=True
                )
                if paused is not None:
                    return paused

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
                answer = self._guardrail_answer(frame, response.text, memory_key, span=span)
                if isinstance(answer, _Outcome):
                    return answer
                frame.messages.append(Message.assistant(answer))
                await self._remember(agent, answer, memory_key)
                self._record_status(span, "completed", frame)
                return self._outcome(RunStatus.COMPLETED, frame, answer=answer)

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
            guarded, paused = self._guardrail_tool_calls(
                frame, response.tool_calls, memory_key, span=span
            )
            if paused is not None:
                return paused
            frame.messages.append(Message.assistant_tool_calls(response.text, guarded))
            if self._needs_approval(agent, guarded, principal):
                checkpoint = self._checkpoint(frame, guarded, memory_key)
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
                    guardrails=tuple(frame.guardrails),
                )

            frame.messages.extend(await self._observe(agent, guarded, principal))

    def _guardrail_text(
        self,
        stage: str,
        frame: _Frame,
        memory_key: str,
        *,
        span: Span,
        rewrite: bool,
    ) -> _Outcome | None:
        """Run a whole-transcript stage (``input``) and apply its action.

        ``rewrite`` is what ``redact`` does here: the last user message is replaced
        with the masked text *in place*, so the model is called on the redacted turn
        rather than on the original with a note attached.
        """
        index = _last_user_index(frame.messages)
        text = "" if index is None else frame.messages[index].content
        verdict = self._guardrails.check_input(frame.agent.stage_guardrails(stage), text)
        self._record_guardrails(frame, verdict, span)
        deciding = verdict.deciding
        if verdict.action == ACTION_BLOCK and deciding is not None:
            raise GuardrailBlockedError(deciding.guardrail, stage, deciding.message)
        if verdict.action == ACTION_ESCALATE:
            return self._guardrail_pause(frame, verdict, memory_key, (), span=span)
        if rewrite and verdict.action == ACTION_REDACT and index is not None:
            frame.messages[index] = Message.user(verdict.text)
        return None

    def _guardrail_answer(
        self,
        frame: _Frame,
        text: str,
        memory_key: str,
        *,
        span: Span,
    ) -> str | _Outcome:
        """Run the ``output`` stage over an answer, returning the text to ship.

        An ``_Outcome`` means the answer is held: an escalation paused the run and
        the checkpoint carries the text, so approving it releases this exact answer
        without paying for a second generation.
        """
        verdict = self._guardrails.check_output(
            frame.agent.stage_guardrails(_GUARDRAIL_OUTPUT), text
        )
        self._record_guardrails(frame, verdict, span)
        deciding = verdict.deciding
        if verdict.action == ACTION_BLOCK and deciding is not None:
            raise GuardrailBlockedError(deciding.guardrail, _GUARDRAIL_OUTPUT, deciding.message)
        if verdict.action == ACTION_ESCALATE:
            return self._guardrail_pause(frame, verdict, memory_key, (), span=span, text=text)
        return verdict.text if verdict.action == ACTION_REDACT else text

    def _guardrail_tool_calls(
        self,
        frame: _Frame,
        calls: Sequence[ToolCall],
        memory_key: str,
        *,
        span: Span,
    ) -> tuple[list[ToolCall], _Outcome | None]:
        """Run the ``tool-call`` stage over every call in one step.

        The guardrail scopes on tool *ids*, so each model name is resolved through
        the IR before the engine sees it. A name the IR does not declare keeps its
        own spelling as the scope key -- it will be refused later for a different
        reason, and mapping it to some other tool's id would let a guardrail scoped
        to one tool decide about another.
        """
        guarded: list[ToolCall] = []
        escalation: GuardrailVerdict | None = None
        for call in calls:
            definition = self._tools_by_name.get(call.name)
            tool_id = definition.id if definition is not None else call.name
            verdict = self._guardrails.check_tool_call(
                frame.agent.stage_guardrails(_GUARDRAIL_TOOL), tool_id, call.arguments
            )
            self._record_guardrails(frame, verdict, span)
            deciding = verdict.deciding
            if verdict.action == ACTION_BLOCK and deciding is not None:
                raise GuardrailBlockedError(deciding.guardrail, _GUARDRAIL_TOOL, deciding.message)
            if verdict.action == ACTION_ESCALATE and escalation is None:
                escalation = verdict
            if verdict.action == ACTION_REDACT:
                call = call.model_copy(update={"arguments": dict(verdict.arguments)})
            guarded.append(call)
        if escalation is not None:
            return guarded, self._guardrail_pause(frame, escalation, memory_key, guarded, span=span)
        return guarded, None

    def _record_guardrails(self, frame: _Frame, verdict: GuardrailVerdict, span: Span) -> None:
        """Record what fired. Every record reaches the result, not only the deciding one."""
        for record in verdict.records:
            frame.guardrails.append(record)
            record_guardrail(span, record)

    def _guardrail_pause(
        self,
        frame: _Frame,
        verdict: GuardrailVerdict,
        memory_key: str,
        calls: Sequence[ToolCall],
        *,
        span: Span,
        text: str = "",
    ) -> _Outcome:
        """Enter HITL for an ``escalate``. A pause, never a failure."""
        deciding = verdict.deciding
        if deciding is None:
            raise ConfigurationError(
                "a guardrail verdict with no deciding record cannot be escalated"
            )
        approval = frame.agent.approval
        escalation = GuardrailEscalation(
            guardrail=deciding.guardrail,
            stage=verdict.stage,
            message=deciding.message,
            channel=approval.channel if approval is not None else _GUARDRAIL_CHANNEL,
            text=text,
        )
        checkpoint = self._checkpoint(frame, calls, memory_key, escalation=escalation)
        record_hitl(
            span,
            phase="pause",
            channel=escalation.channel,
            when=f"guardrail:{deciding.guardrail}",
            step=frame.step,
        )
        self._record_status(span, "paused", frame)
        return _Outcome(
            status=RunStatus.PAUSED,
            agent_id=frame.agent.id,
            steps=frame.steps,
            path=frame.path,
            checkpoint=checkpoint,
            guardrails=tuple(frame.guardrails),
        )

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
        outcome.guardrails = (*frame.guardrails, *outcome.guardrails)
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
            inner.guardrails = (*frame.guardrails, *inner.guardrails)
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
            inner.guardrails = (*frame.guardrails, *inner.guardrails)
            return inner
        frame.steps.extend(inner.steps)
        frame.guardrails.extend(inner.guardrails)
        frame.messages.append(Message.tool(call.id, inner.answer, name=call.name))
        return await self._run_loop(
            frame, budget=budget, principal=principal, memory_key=memory_key, span=span
        )

    async def _observe(
        self, agent: AgentDefinition, calls: Sequence[ToolCall], principal: Principal
    ) -> list[Message]:
        """Turn calls into observations, in the order the model asked for them.

        A name this agent cannot call comes back as a tool error instead of
        raising: the model composed the call, so the model is the party that can
        correct it, exactly as for bad arguments. A missing *registration* is a
        different failure and is refused when the runtime is built, where the
        application can fix it.

        Permission is the third case and it does raise, before any handler runs.
        The grant is the agent's declared tool list, and a side-effecting tool
        additionally needs an ``auth`` policy that holds for this principal. A
        model cannot repair either: the spec is what is wrong.
        """
        known = [call for call in calls if call.name in self._executor.names]
        for call in known:
            self._authorize(agent, call, principal)
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

    def _authorize(self, agent: AgentDefinition, call: ToolCall, principal: Principal) -> None:
        """Refuse a call this agent may not make, before the handler body runs.

        Deny by default, in three steps:

        1. the agent must declare the tool -- the IR's ``tools`` is the grant, and
           an undeclared tool is refused even when the runtime has it registered;
        2. a ``write``/``destructive`` tool must declare an ``auth`` policy, because
           a side effect with no authorization is an accident waiting to be called;
        3. that policy is evaluated here, against *this* principal, not at build
           time -- ``auth`` is a question about the caller, and the caller is only
           known now.

        An undecidable policy is a denial. :class:`PolicyEvaluationError` means the
        evaluator could not answer, and "could not answer" must never render as
        "allowed".
        """
        granted = {self._spec.tools[tool_id].name for tool_id in agent.tools}
        if call.name not in granted:
            raise ToolPermissionError(
                agent.id,
                call.name,
                "the agent does not declare it; the tool list is the grant, and there is "
                "no implicit wildcard",
            )
        definition = self._tools_by_name.get(call.name)
        if definition is None:
            raise ToolPermissionError(
                agent.id,
                call.name,
                "it is registered on this runtime but not declared in the IR, so its side "
                "effects and auth policy are unknown",
            )
        if definition.auth is not None:
            try:
                allowed = evaluate_policy(definition.auth, principal)
            except PolicyEvaluationError as exc:
                raise ToolPermissionError(
                    agent.id,
                    call.name,
                    f"its auth policy {policy_source(definition.auth)} could not be decided "
                    f"({exc})",
                ) from exc
            if not allowed:
                raise ToolPermissionError(
                    agent.id,
                    call.name,
                    f"its auth policy {policy_source(definition.auth)} denies this principal",
                )
            return
        if definition.side_effects in _SIDE_EFFECTING:
            raise ToolPermissionError(
                agent.id,
                call.name,
                f"it has sideEffects {definition.side_effects!r} and declares no auth "
                "policy; a side effect with no authorization is denied by default",
            )

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
        self,
        frame: _Frame,
        calls: Sequence[ToolCall],
        memory_key: str,
        *,
        escalation: GuardrailEscalation | None = None,
    ) -> AgentCheckpoint:
        approval = frame.agent.approval
        if escalation is not None:
            channel = escalation.channel
        elif approval is not None:
            channel = approval.channel
        else:
            channel = _TOOL_CONFIRMATION
        return AgentCheckpoint(
            agent_id=frame.agent.id,
            step=frame.step,
            messages=tuple(frame.messages),
            steps=tuple(frame.steps),
            calls=tuple(calls),
            channel=channel,
            when=dict(approval.when) if approval is not None else {},
            cost_anchor_usd=frame.cost_anchor,
            token_anchor=frame.token_anchor,
            spent_usd=self._gateway.ledger.cost_usd,
            spent_tokens=self._gateway.ledger.total_tokens,
            degraded=frame.degraded,
            alias=frame.alias,
            path=frame.path,
            memory_key=memory_key,
            escalation=escalation,
            guardrails=tuple(frame.guardrails),
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
            # A checkpoint exists only after the input stage ran, so a resumed frame
            # must not re-check the message it already passed -- and must not re-apply
            # a redaction to text that is already masked.
            input_checked=True,
            guardrails=list(checkpoint.guardrails),
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
        """Refuse an engine this runtime cannot run, before any work is done.

        The validation itself lives in :func:`aid_runtime.agents.engine.check_engine`
        so there is one place to read to know whether an engine is supported. A
        runtime that quietly ran a ``deepagents`` agent on the native loop would leave
        ``engine`` in the IR meaning nothing at all.
        """
        check_engine(agent)

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
            guardrails=tuple(frame.guardrails),
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
            guardrails=outcome.guardrails,
        )


def _budget_of(thread: ThreadMemory) -> int:
    return thread.token_budget if thread.token_budget is not None else 0


def _last_user_index(messages: Sequence[Message]) -> int | None:
    """The turn the input stage guards: the most recent user message."""
    for index in range(len(messages) - 1, -1, -1):
        if messages[index].role == "user":
            return index
    return None


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
