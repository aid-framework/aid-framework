"""Expose :class:`~aid_runtime.gateway.ModelGateway` as a LangChain chat model.

This module is the load-bearing part of the Deep Agents backend. A harness that
imports ``langchain-anthropic`` and calls the provider itself would keep working
while silently dropping every guarantee the gateway exists to provide: the
fallback chain, the budget preflight, the cost ledger and the per-attempt LLM
span. The agent would look fine and the budget would stop applying. That is the
exact defect class this project was built to prevent, so the harness is never
handed a provider -- it is handed *this adapter*, and every model call inside the
graph goes back out through our gateway.

What the adapter is responsible for:

* **Translation, both directions.** LangChain messages to our :class:`Message`,
  and our :class:`CompletionResponse` back to an ``AIMessage`` with tool calls,
  ``usage_metadata`` and the alias/cost the gateway actually charged. The alias
  matters: a fallback means the answer did not come from the pinned model, and
  the response says so rather than letting the harness believe otherwise.
* **Tool filtering.** ``bind_tools`` is the single funnel every tool reaches the
  model through, which makes it the one place to enforce what the agent is
  actually allowed to call. Deep Agents bundles ``ls``/``read_file``/``write_file``/
  ``edit_file``/``delete``/``glob``/``grep``/``execute`` and binds all of them; the
  allow-list drops everything the agent did not declare, so the filesystem and
  shell tools are unreachable rather than merely undocumented.
* **Budget continuity.** The agent's ceiling is passed to every call, so a breach
  surfaces as the gateway's own :class:`~aid_runtime.errors.BudgetExceededError`
  from inside the harness. There is no second accounting path here to disagree
  with it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Any

from langchain_core.callbacks import (
    AsyncCallbackManagerForLLMRun,
    CallbackManagerForLLMRun,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

from aid_runtime.cost import Budget
from aid_runtime.errors import DeepAgentsEngineError, DeepAgentsMaxStepsError
from aid_runtime.gateway import ModelGateway
from aid_runtime.types import CompletionRequest, Message, ToolCall, ToolDefinition

__all__ = [
    "GatewayChatModel",
    "to_aid_messages",
    "to_langchain_messages",
    "to_tool_definitions",
]


class GatewayChatModel(BaseChatModel):
    """A LangChain chat model whose every generation is a gateway call.

    Construct it with the alias the IR pinned, the gateway that owns fallback and
    accounting, and the ceiling this agent is allowed to spend. ``allowed_tools``
    is the tool allow-list: ``None`` admits everything the harness binds, which is
    only appropriate for an agent that declares no tools.
    """

    gateway: ModelGateway
    alias: str
    fallbacks: tuple[str, ...] = ()
    budget: Budget | None = None
    allowed_tools: frozenset[str] | None = None
    #: The agent's ``maxSteps``, counted in model calls. Enforced here because this
    #: adapter is the only place that sees every model call -- and because the
    #: harness's own limiter completes the run with a synthetic answer instead of
    #: failing. ``None`` disables the counter (used by the offline fixtures).
    max_calls: int | None = None
    #: What ``bind_tools`` last admitted. Read by tests, never by the harness.
    bound_tools: tuple[ToolDefinition, ...] = ()
    #: Every generation this model produced, in order. The proof that the harness
    #: went through us rather than around us.
    calls: list[Any] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "aid-gateway"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {"alias": self.alias, "fallbacks": list(self.fallbacks)}

    def bind_tools(
        self,
        tools: Sequence[Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> GatewayChatModel:
        """Admit only the tools this agent declared.

        Every tool the harness offers -- bundled ones included -- arrives here, so
        an allow-list applied at this point is the difference between "we do not
        document a shell" and "there is no shell the model can reach". The filtered
        set is kept on a copy rather than on ``self`` so two agents sharing one
        adapter cannot widen each other's grant.
        """
        admitted = to_tool_definitions(tools, allowed=self.allowed_tools)
        return self.model_copy(update={"bound_tools": admitted})

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        raise DeepAgentsEngineError(
            "the deepagents engine generates asynchronously only; the gateway's providers "
            "are async, so a synchronous invoke cannot route through it without a second "
            "accounting path. Use ainvoke."
        )

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        """One harness model call, routed through the gateway.

        ``fallbacks`` and ``budget`` travel with the call, so the harness gets the
        same fallback behaviour and the same hard ceiling as the native loop. A
        breach is raised, not returned: the harness must not be able to continue
        past a budget the ledger already refused.
        """
        request = CompletionRequest(
            messages=to_aid_messages(messages),
            tools=self.bound_tools,
        )
        if self.max_calls is not None and len(self.calls) >= self.max_calls:
            # Refused before the call, not after: an agent that has spent its step
            # budget must not spend one more to discover that it has.
            raise DeepAgentsMaxStepsError(self.alias, self.max_calls)
        generation = await self.gateway.generate(
            self.alias, request, fallbacks=self.fallbacks, budget=self.budget
        )
        self.calls.append(generation)
        return ChatResult(generations=[ChatGeneration(message=self._to_ai_message(generation))])

    def _to_ai_message(self, generation: Any) -> AIMessage:
        """Carry the gateway's answer across, including what it cost and where from."""
        response = generation.response
        usage = generation.usage
        return AIMessage(
            content=response.text,
            tool_calls=[
                {
                    "name": call.name,
                    "args": dict(call.arguments),
                    "id": call.id,
                    "type": "tool_call",
                }
                for call in response.tool_calls
            ],
            usage_metadata={
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "total_tokens": usage.total_tokens,
            },
            response_metadata={
                "model": response.model,
                "provider": response.provider,
                "finish_reason": response.finish_reason,
                # Not decoration: after a fallback these differ from the alias the
                # IR pinned, and that has to stay visible to the caller.
                "alias": generation.alias,
                "cost_usd": generation.cost_usd,
                "fell_back": generation.fell_back,
            },
        )

    def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[Any]:
        raise DeepAgentsEngineError(
            "streaming is not exposed through the deepagents engine: "
            "ModelGateway.stream serves Server-Sent Event bytes for the HTTP layer, "
            "but the engine consumes request/response via agenerate/ainvoke and never "
            "an SSE byte stream. A structured LangChain chunk stream would be a second "
            "streaming contract and a second accounting path, so it is refused here "
            "rather than buffered into a non-stream."
        )


def to_aid_messages(messages: Sequence[BaseMessage]) -> tuple[Message, ...]:
    """Translate the harness transcript into ours.

    Tool calls and their ids are preserved verbatim: the harness pairs a result
    with its call by id, and renaming or renumbering them here would break the
    pairing in a way that only shows up as a tool result attached to the wrong
    call.
    """
    converted: list[Message] = []
    for message in messages:
        if isinstance(message, SystemMessage):
            converted.append(Message.system(_text(message)))
        elif isinstance(message, HumanMessage):
            converted.append(Message.user(_text(message)))
        elif isinstance(message, AIMessage):
            calls = tuple(
                ToolCall(
                    id=str(call.get("id") or f"call_{index}"),
                    name=str(call.get("name") or ""),
                    arguments=dict(call.get("args") or {}),
                )
                for index, call in enumerate(message.tool_calls)
            )
            if calls:
                converted.append(Message.assistant_tool_calls(_text(message), calls))
            else:
                converted.append(Message.assistant(_text(message)))
        elif isinstance(message, ToolMessage):
            converted.append(
                Message.tool(
                    str(message.tool_call_id),
                    _text(message),
                    name=str(message.name) if message.name else None,
                )
            )
        else:
            # Deep Agents may hand us one of its own message subclasses. Dropping it
            # would lose a turn from the transcript, so it is carried as plain text.
            converted.append(Message.user(_text(message)))
    return tuple(converted)


def to_tool_definitions(
    tools: Sequence[Any], *, allowed: frozenset[str] | None = None
) -> tuple[ToolDefinition, ...]:
    """Normalise the harness's tool specs and drop everything outside the grant.

    The harness offers OpenAI-shaped dicts, sometimes a bare ``BaseTool``. Both are
    accepted so the allow-list cannot be bypassed by a shape the filter did not
    recognise: anything unparseable has no name, and a tool with no name is
    refused rather than passed through.
    """
    definitions: list[ToolDefinition] = []
    for tool in tools:
        definition = _tool_definition(tool)
        if definition is None:
            continue
        if allowed is not None and definition.name not in allowed:
            continue
        definitions.append(definition)
    return tuple(definitions)


def _tool_definition(tool: Any) -> ToolDefinition | None:
    if isinstance(tool, dict):
        body = tool.get("function") if tool.get("type") == "function" else tool
        if not isinstance(body, dict):
            return None
        name = body.get("name")
        parameters = body.get("parameters")
        description = body.get("description")
    else:
        name = getattr(tool, "name", None)
        description = getattr(tool, "description", "")
        schema = getattr(tool, "args_schema", None)
        parameters = schema if isinstance(schema, dict) else None
        if parameters is None and schema is not None and hasattr(schema, "model_json_schema"):
            # A LangChain tool normally carries a pydantic model here. Reading it as
            # a dict keeps the model's parameter schema intact instead of handing it
            # an empty one, which would only fail later as a tool call with no args.
            try:
                parameters = schema.model_json_schema()
            except (TypeError, ValueError):
                parameters = None
    if not isinstance(name, str) or not name:
        return None
    return ToolDefinition(
        name=name,
        description=str(description or ""),
        parameters=dict(parameters) if isinstance(parameters, dict) else {},
    )


def _text(message: BaseMessage) -> str:
    """Flatten message content to text, keeping block content that carries prose."""
    content = message.content
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "".join(parts)


def to_langchain_messages(messages: Sequence[Message]) -> list[BaseMessage]:
    """Translate our transcript back out, for seeding the harness with prior turns.

    This exists so a resumed run hands the harness the same transcript the native
    loop would have, rather than a summary of it. Tool calls are re-emitted as
    ``AIMessage.tool_calls`` so the harness sees them as calls it can pair, which
    is what keeps a resumed run's transcript comparable to an uninterrupted one.
    """
    converted: list[BaseMessage] = []
    for message in messages:
        if message.role == "system":
            converted.append(SystemMessage(content=message.content))
        elif message.role == "user":
            converted.append(HumanMessage(content=message.content))
        elif message.role == "tool":
            converted.append(
                ToolMessage(
                    content=message.content,
                    tool_call_id=message.tool_call_id or "",
                    name=message.name or "",
                )
            )
        elif message.tool_calls:
            converted.append(
                AIMessage(
                    content=message.content,
                    tool_calls=[
                        {
                            "name": call.name,
                            "args": dict(call.arguments),
                            "id": call.id,
                            "type": "tool_call",
                        }
                        for call in message.tool_calls
                    ],
                )
            )
        else:
            converted.append(AIMessage(content=message.content))
    return converted
