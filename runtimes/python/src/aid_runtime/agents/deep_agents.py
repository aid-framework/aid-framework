"""The ``deepagents`` orchestration backend.

Deep Agents is a *backend*, not the IR and not the gateway. An agent that declares
``engine: deepagents`` is driven by :func:`deepagents.create_deep_agent`; every other
agent keeps running on the native loop in :mod:`aid_runtime.agents.loop`, which is
unchanged. The two share the frame, the checkpoint, the ledger and the guardrail
engine -- the seam is a drive function, not a second definition of what an agent is.

Two boundaries are load-bearing, and they are why this module is small.

**The model boundary.** The harness is never handed a provider. It is handed
:class:`~aid_runtime.agents.chat_model.GatewayChatModel`, so fallback, budget, ledger
and spans keep applying inside the graph. Without that adapter the budget guarantee
would silently stop applying the moment an agent ran here -- the agent would look
fine and the ceiling would be gone.

**The capability boundary.** A mapping the harness cannot express is refused rather
than approximated. Transfer is the clear case: ``subagents`` are delegation with a
return, and there is no primitive that hands the conversation to another agent and
never comes back. An agent declaring ``handoffs`` therefore does not start at all
(see :func:`~aid_runtime.agents.engine.check_engine`). Silently degrading transfer
into delegation would still answer *something*, and the difference would only show
up in an eval baseline.

What this module deliberately does not do, and does not claim: filesystem, shell or
skill tools (the adapter's allow-list makes them unreachable, and they are not
enabled here), streaming (the adapter raises, because a streaming path needs its own
span and ledger accounting rather than an improvised one), and LangSmith (our OTel
spans are the required trace; LangSmith is absent and off).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from deepagents import create_deep_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.types import Command
from opentelemetry.trace import Span, get_current_span

from aid_runtime.agents.chat_model import GatewayChatModel, to_langchain_messages
from aid_runtime.agents.engine import DEEPAGENTS, check_engine
from aid_runtime.agents.ir import AgentDefinition
from aid_runtime.agents.loop import _GUARDRAIL_INPUT, _Frame, _Outcome
from aid_runtime.agents.policy import Principal
from aid_runtime.agents.state import RunStatus, StepKind, StepRecord
from aid_runtime.cost import Budget
from aid_runtime.errors import DeepAgentsEngineError, DeepAgentsMaxStepsError
from aid_runtime.tracing import agent_span, record_hitl
from aid_runtime.types import Capability, Message, ToolCall

if TYPE_CHECKING:
    from aid_runtime.agents.loop import AgentRuntime

__all__ = ["DeepAgentsEngine"]

#: Graph super-steps one model call can cost, used to size the recursion limit from
#: the agent's ``maxSteps``. The adapter's call counter is the real ceiling; this is
#: the backstop for a graph that cycles without spending a model call, so it is set
#: with room above the counter rather than exactly at it.
_RECURSION_PER_STEP = 4

#: The smallest recursion limit a run is built with: even ``maxSteps`` of 1 needs room
#: for the model call plus the tool super-step that follows it.
_MIN_RECURSION = 8

#: The harness's own delegation tool. It is the ``task`` builtin: a delegate is
#: called with a task and returns a result, which is delegation, not transfer.
_DELEGATE_TOOL = "task"


class _HaltError(Exception):
    """A guardrail decided the run, from inside the graph.

    Raised from middleware and caught by :meth:`DeepAgentsEngine.drive`. The harness
    turns an ordinary tool error into a tool message and lets the graph continue,
    which is right for a bad argument and wrong for a guardrail: a blocked call
    delivered as an observation is a blocked call the model can route around. A
    raise from middleware propagates out of ``ainvoke``, so this is the only shape in
    which a tool-stage decision leaves the harness still a decision.
    """

    def __init__(self, outcome: _Outcome) -> None:
        super().__init__(outcome.status.value)
        self.outcome = outcome


class DeepAgentsEngine:
    """Drives one frame on the Deep Agents harness.

    Built per frame rather than held on the runtime, so no previous run's tools,
    interrupt arming or transcript can survive into the next one.
    """

    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime

    async def drive(
        self,
        frame: _Frame,
        *,
        budget: Budget | None,
        principal: Principal,
        memory_key: str,
        span: Span,
    ) -> _Outcome:
        """Run ``frame`` to a stop condition on the harness, reported in our terms."""
        agent = frame.agent
        check_engine(agent)
        if not frame.input_checked:
            frame.input_checked = True
            paused = self._runtime._guardrail_text(
                _GUARDRAIL_INPUT, frame, memory_key, span=span, rewrite=True
            )
            if paused is not None:
                return paused

        models: list[tuple[str, GatewayChatModel]] = []
        graph = self._graph(frame, principal=principal, budget=budget, span=span, models=models)
        config = self._config(agent, memory_key)
        try:
            result = await self._invoke(graph, frame, config, principal=principal)
        except _HaltError as halt:
            self._record_steps(frame, models)
            self._runtime._record_status(span, halt.outcome.status.value, frame)
            return halt.outcome
        except DeepAgentsMaxStepsError:
            self._record_steps(frame, models)
            self._runtime._record_status(span, "max-steps", frame)
            return self._runtime._outcome(RunStatus.MAX_STEPS, frame)
        except GraphRecursionError:
            # The backstop. A graph that cycled without spending a model call has
            # still exhausted the agent's step budget; reporting it as a harness
            # crash would hide an agent that never terminates.
            self._record_steps(frame, models)
            self._runtime._record_status(span, "max-steps", frame)
            return self._runtime._outcome(RunStatus.MAX_STEPS, frame)

        self._record_steps(frame, models)
        paused = self._pause(frame, result, memory_key=memory_key, span=span)
        if paused is not None:
            return paused
        return await self._complete(frame, result, memory_key=memory_key, span=span)

    # -- graph -------------------------------------------------------------------

    def _graph(
        self,
        frame: _Frame,
        *,
        principal: Principal,
        budget: Budget | None,
        span: Span,
        models: list[tuple[str, GatewayChatModel]],
    ) -> Any:
        """Build the harness graph.

        ``models`` is passed in and filled here because those adapters are the only
        record of what the harness spent: every generation they hold came back
        through the gateway, which is what makes the run's cost auditable.
        """
        agent = frame.agent
        interrupts: dict[str, Any] | None = self._interrupts(agent)
        subagents: Any = (
            self._subagents(frame, principal=principal, budget=budget, span=span, models=models)
            or None
        )
        return create_deep_agent(
            model=self._model(agent, frame=frame, budget=budget, span=span, models=models),
            tools=self._tools(agent, frame=frame, principal=principal, span=span),
            system_prompt=self._runtime.spec.system_prompt(agent),
            middleware=[
                _Guardrails(
                    self,
                    frame,
                    principal=principal,
                    span=span,
                    memory_key=frame.memory_key,
                )
            ],
            subagents=subagents,
            interrupt_on=interrupts,
            # Only a run that can be interrupted needs a checkpointer, and the pause
            # it enables is a suspension point, never the decision itself.
            checkpointer=InMemorySaver() if interrupts else None,
            name=agent.id,
        )

    def _model(
        self,
        agent: AgentDefinition,
        *,
        frame: _Frame,
        budget: Budget | None,
        span: Span,
        models: list[tuple[str, GatewayChatModel]],
    ) -> GatewayChatModel:
        """The adapter for one agent, with the capability check the loop also makes.

        A model that cannot tool-call would answer from memory and look fine, and a
        gateway fallback is chosen for a provider failure without re-negotiating
        capabilities. Checking here is what keeps that guarantee inside the harness
        instead of only on the native path.
        """
        required = frozenset(
            {Capability.TOOL_CALLING} if agent.tools or agent.has_control_tools else set()
        )
        if required:
            self._runtime.gateway.require(agent.model, required)
        allowed = {self._runtime.spec.tools[tool_id].name for tool_id in agent.tools}
        if agent.delegates:
            # Delegation is the one harness tool this engine exposes on purpose, and
            # only an agent that declares a delegate gets it. It carries no side
            # effect of its own: the delegate's own grant governs what it may do.
            allowed.add(_DELEGATE_TOOL)
        model = GatewayChatModel(
            gateway=self._runtime.gateway,
            alias=agent.model,
            fallbacks=self._runtime.spec.fallbacks_for(agent.model),
            budget=budget,
            allowed_tools=frozenset(allowed),
            max_calls=max(agent.max_steps - frame.step, 0),
        )
        models.append((agent.id, model))
        return model

    def _subagents(
        self,
        frame: _Frame,
        *,
        principal: Principal,
        budget: Budget | None,
        span: Span,
        models: list[tuple[str, GatewayChatModel]],
    ) -> list[dict[str, Any]]:
        """Map ``delegates`` onto ``subagents``: delegation with isolated context.

        The harness gives a subagent only the task it was handed and returns its
        result to the caller, which is what a delegate is. Each subagent gets its own
        model and its own tool grant, so a delegate cannot inherit the caller's
        allow-list or spend against the caller's step budget.

        Each subagent also carries its own ``_Guardrails``, because the harness builds
        a subagent's middleware list from the spec and nothing else: an omitted
        ``middleware`` key means the delegate's graph has no tool-call guardrail at
        all, and the caller's middleware does not reach inside it. That is the native
        loop's semantic too -- ``_delegate`` opens a frame for the target and drives
        it, so the *target's* ``stage_guardrails("tool-call")`` is what runs, and the
        caller's does not cross the boundary.
        """
        built: list[dict[str, Any]] = []
        for target_id in frame.agent.delegates:
            target = self._runtime.spec.agent(target_id)
            check_engine(target)
            built.append(
                {
                    "name": target.id,
                    "description": target.name or target.id,
                    "system_prompt": self._runtime.spec.system_prompt(target),
                    "model": self._model(
                        target,
                        frame=frame,
                        budget=budget,
                        span=span,
                        models=models,
                    ),
                    "tools": self._tools(target, frame=frame, principal=principal, span=span),
                    "middleware": [
                        _Guardrails(
                            self,
                            _delegate_frame(frame, target),
                            principal=principal,
                            # The delegate's span cannot exist yet: the harness runs
                            # it inline from the `task` call, and the caller's
                            # middleware opens that span around the dispatch. Resolving
                            # the then-current span is what keeps the delegate's records
                            # off the caller's span. See `_delegate_in_span`.
                            span=None,
                            memory_key=frame.memory_key,
                        )
                    ],
                }
            )
        return built

    def _tools(
        self,
        agent: AgentDefinition,
        *,
        frame: _Frame,
        principal: Principal,
        span: Span,
    ) -> list[Any]:
        """Wrap each declared tool as a harness tool whose body is our executor.

        The body is deliberately thin: authorization and the tool-call guardrail run
        in the ``_Guardrails`` middleware of whichever agent is calling -- the caller's
        for the caller's tools, the delegate's own for the delegate's -- and execution
        goes through the same ``ToolExecutor`` the native loop uses. That is what makes
        a tool call under this engine the same event in the trace as one under the
        native engine.
        """
        tools: list[Any] = []
        for tool_id in agent.tools:
            spec = self._runtime.spec.tools[tool_id]
            definition = self._runtime._executor.definition(spec.name)

            async def _call(
                _agent: AgentDefinition = agent, _name: str = spec.name, **kwargs: Any
            ) -> str:
                # The id is derived, not random: the harness pairs a result with its
                # call by id, and a random one would make two identical runs differ.
                call = ToolCall(id=f"{_agent.id}:{_name}", name=_name, arguments=kwargs)
                observations = await self._runtime._observe(_agent, [call], principal)
                return observations[0].content

            tools.append(
                StructuredTool.from_function(
                    coroutine=_call,
                    name=spec.name,
                    description=definition.description or spec.name,
                    args_schema=definition.parameters,
                )
            )
        return tools

    def _interrupts(self, agent: AgentDefinition) -> dict[str, bool] | None:
        """Which tools arm the harness's interrupt.

        A tool the IR marks ``requiresConfirmation`` always arms it. When the agent
        carries a ``humanInTheLoop.when`` policy, every tool arms it, and the policy
        itself is then evaluated by us when the interrupt fires -- an interrupt the
        policy does not cover is released immediately, so the pause a caller observes
        is always our policy's and never the harness's default.
        """
        armed = {
            self._runtime.spec.tools[tool_id].name
            for tool_id in agent.tools
            if self._runtime.spec.tools[tool_id].requires_confirmation
        }
        if agent.approval is not None:
            armed |= {self._runtime.spec.tools[tool_id].name for tool_id in agent.tools}
        return dict.fromkeys(sorted(armed), True) or None

    @staticmethod
    def _config(agent: AgentDefinition, memory_key: str) -> dict[str, Any]:
        return {
            "recursion_limit": max(agent.max_steps * _RECURSION_PER_STEP, _MIN_RECURSION),
            "configurable": {"thread_id": f"{agent.id}:{memory_key}"},
        }

    async def _invoke(
        self, graph: Any, frame: _Frame, config: dict[str, Any], *, principal: Principal
    ) -> Any:
        """Invoke the graph, releasing any interrupt our own policy does not hold."""
        seeds = to_langchain_messages(
            [message for message in frame.messages if message.role != "system"]
        )
        result = await graph.ainvoke({"messages": seeds}, config=config)
        while True:
            pending = result.get("__interrupt__")
            if not pending:
                return result
            calls = self._interrupted(pending)
            if self._runtime._needs_approval(frame.agent, calls, principal):
                return result
            result = await graph.ainvoke(
                Command(resume={"decisions": [{"type": "approve"} for _ in calls]}),
                config=config,
            )

    # -- outcomes ----------------------------------------------------------------

    @staticmethod
    def _interrupted(pending: Any) -> list[ToolCall]:
        """The calls a pause is holding, as our own type.

        The harness reports a description of each held action rather than the call it
        composed, so the id is derived from position when none is supplied. It only
        has to pair a resumed observation with its call, and a derived id is stable
        across a replay where a random one would not be.
        """
        calls: list[ToolCall] = []
        for index, interrupt in enumerate(pending):
            value = getattr(interrupt, "value", interrupt)
            requests = value.get("action_requests") if isinstance(value, dict) else None
            for position, request in enumerate(requests or ()):
                name = str(request.get("name", ""))
                if not name:
                    continue
                arguments = request.get("args")
                calls.append(
                    ToolCall(
                        id=str(request.get("id") or f"interrupt-{index}-{position}"),
                        name=name,
                        arguments=dict(arguments) if isinstance(arguments, dict) else {},
                    )
                )
        return calls

    def _pause(self, frame: _Frame, result: Any, *, memory_key: str, span: Span) -> _Outcome | None:
        """Turn a held interrupt into our checkpoint, or ``None`` when nothing is held."""
        pending = result.get("__interrupt__")
        if not pending:
            return None
        calls = self._interrupted(pending)
        if not calls:
            raise DeepAgentsEngineError(
                f"agent {frame.agent.id!r} paused on an interrupt that named no tool call; "
                "the harness's interrupt payload has changed shape"
            )
        checkpoint = self._runtime._checkpoint(frame, calls, memory_key)
        record_hitl(span, phase="pause", channel=checkpoint.channel, step=frame.step)
        self._runtime._record_status(span, "paused", frame)
        return _Outcome(
            status=RunStatus.PAUSED,
            agent_id=frame.agent.id,
            steps=frame.steps,
            path=frame.path,
            checkpoint=checkpoint,
            guardrails=tuple(frame.guardrails),
        )

    async def _complete(
        self, frame: _Frame, result: Any, *, memory_key: str, span: Span
    ) -> _Outcome:
        """Apply the output guardrail, record memory, and report the answer."""
        released = self._runtime._guardrail_answer(
            frame, self._answer(result), memory_key, span=span
        )
        if isinstance(released, _Outcome):
            return released
        frame.messages.append(Message.assistant(released))
        await self._runtime._remember(frame.agent, released, memory_key)
        self._runtime._record_status(span, "completed", frame)
        return self._runtime._outcome(RunStatus.COMPLETED, frame, answer=released)

    @staticmethod
    def _answer(result: Any) -> str:
        """The last thing the model said, which is what a native run would report."""
        for message in reversed(result.get("messages") or ()):
            if getattr(message, "type", "") != "ai":
                continue
            content = getattr(message, "content", "")
            if isinstance(content, str):
                return content
            return "".join(
                block["text"]
                for block in content
                if isinstance(block, dict) and isinstance(block.get("text"), str)
            )
        return ""

    def _record_steps(self, frame: _Frame, models: list[tuple[str, GatewayChatModel]]) -> None:
        """Append one step per model call, in the order the gateway charged them.

        The alias, cost and tokens come from the generation the gateway returned, so
        a fallback appears in the step exactly as it would under the native loop.
        """
        for agent_id, model in models:
            for generation in model.calls:
                frame.step += 1
                response = generation.response
                frame.steps.append(
                    StepRecord(
                        index=frame.step,
                        agent_id=agent_id,
                        kind=StepKind.TOOLS if response.tool_calls else StepKind.ANSWER,
                        alias=generation.alias,
                        model=response.model,
                        cost_usd=generation.cost_usd,
                        total_tokens=generation.usage.total_tokens,
                        tool_names=tuple(call.name for call in response.tool_calls),
                    )
                )
            model.calls.clear()


class _Guardrails(AgentMiddleware):
    """Our authorization and guardrail engine, at the tool-call boundary.

    The harness has no guardrail concept, so this is where ours wraps it. It runs
    before the tool body, which is the only point where a decision can still stop the
    call, and it raises rather than returning an observation so the harness cannot
    hand the decision back to the model as something to work around.

    One instance is bound to one frame. The caller's is built with ``_graph``; a
    delegate's is attached to its subagent spec by ``_subagents`` and bound to the
    delegate's frame, which is the same split the native loop makes by driving each
    frame with its own agent's guardrails.
    """

    def __init__(
        self,
        engine: DeepAgentsEngine,
        frame: _Frame,
        *,
        principal: Principal,
        span: Span | None,
        memory_key: str,
    ) -> None:
        super().__init__()
        self._engine = engine
        self._frame = frame
        self._principal = principal
        self._span = span
        self._memory_key = memory_key

    @property
    def _record_span(self) -> Span:
        """The span this middleware's records belong to.

        The caller's instance is handed the span its frame already opened. A
        delegate's is not: it is built with the graph, before the harness has run
        anything, so the delegate's span is opened later, around the ``task``
        dispatch, and is simply the span current when the delegate's tool call runs.
        Without that, a delegate's guardrail record would be attributed to the caller.
        """
        return self._span if self._span is not None else get_current_span()

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        call = _as_call(request)
        runtime = self._engine._runtime
        if call.name == _DELEGATE_TOOL:
            # Delegation is the harness's own dispatch, not a declared tool: there is
            # no IR entry to authorize or guard against. It is not unguarded, though.
            # The subagent spec carries a `_Guardrails` bound to the delegate's frame,
            # so the delegate's own guardrails decide its tool calls -- the caller's do
            # not cross the boundary, exactly as the native loop's `_delegate` runs the
            # target's frame instead of applying the caller's guardrails to it. This
            # branch only has to open the delegate's span.
            return await self._delegate_in_span(request, handler, call)
        runtime._authorize(self._frame.agent, call, self._principal)
        guarded, halted = runtime._guardrail_tool_calls(
            self._frame, [call], self._memory_key, span=self._record_span
        )
        if halted is not None:
            raise _HaltError(halted)
        if guarded and guarded[0].arguments != call.arguments:
            # A redaction rewrote the arguments; the tool must see the rewritten
            # ones, not the model's originals.
            request = request.override(
                tool_call={**request.tool_call, "args": guarded[0].arguments}
            )
        return await handler(request)

    async def _delegate_in_span(self, request: Any, handler: Any, call: ToolCall) -> Any:
        """Run the harness's delegation inside the delegate's own span.

        The harness runs a subagent inline rather than through ``AgentRuntime._drive``,
        so this is the one place the delegate's agent span can be opened. Without it the
        delegate's model spans and guardrail records would all be children of the
        caller's span, and a decision the delegate made would be reported as one the
        caller made. A malformed ``task`` call names no delegate and is left alone --
        the harness rejects those before any subagent runs.
        """
        target_id = call.arguments.get("subagent_type")
        target = (
            self._engine._runtime.spec.agents.get(target_id) if isinstance(target_id, str) else None
        )
        if target is None:
            return await handler(request)
        with agent_span(
            agent_id=target.id, engine=DEEPAGENTS, tracer=self._engine._runtime._tracer
        ):
            return await handler(request)


def _delegate_frame(caller: _Frame, target: AgentDefinition) -> _Frame:
    """The frame a delegate's tool calls are decided under.

    The harness keeps a subagent's transcript, so this frame carries no messages: it
    exists because authorization and the guardrail engine need the target's own agent
    definition, its position in the run's path and the run's memory key. It shares the
    caller's ``guardrails`` list so a delegate's records reach the run's result, which
    is what ``_delegate`` does on the native loop when it extends the caller's list.
    """
    return _Frame(
        agent=target,
        messages=[],
        alias=target.model,
        path=(*caller.path, target.id),
        memory_key=caller.memory_key,
        guardrails=caller.guardrails,
    )


def _as_call(request: Any) -> ToolCall:
    raw = request.tool_call
    arguments = raw.get("args")
    return ToolCall(
        id=str(raw.get("id") or raw.get("name") or "tool-call"),
        name=str(raw.get("name") or ""),
        arguments=dict(arguments) if isinstance(arguments, dict) else {},
    )
