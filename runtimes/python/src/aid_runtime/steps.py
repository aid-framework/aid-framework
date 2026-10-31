"""Leaf pipeline steps: ``generate``, ``retrieve``, ``tool`` and ``emit``.

:mod:`~aid_runtime.pipeline` runs steps and :mod:`~aid_runtime.control` composes
them; this module is the third part of the family and builds the leaves a pipeline
actually reaches the outside world with. Each factory returns an ordinary
:data:`~aid_runtime.pipeline.Step`, so a leaf composes with a composite by the same
rule and replays unchanged on the streaming route.

Why these exist at all: a generated application inlines its steps as hand-written
async functions, which leaves a caller who is *not* the generator -- a test, a
conformance runner, a hand-built pipeline -- with no way to drive one step kind
without re-writing the primitive's call and its binding rule. That duplication is
where the two disagree. A step here is the same primitive the generator calls:

* ``retrieve`` calls :meth:`~aid_runtime.retrieval.Retriever.retrieve` and binds
  the :class:`~aid_runtime.retrieval.RetrievalResult` it returns.
* ``tool`` calls :meth:`~aid_runtime.tools.ToolExecutor.execute` and binds what the
  tool returned, refusing an error outcome and parsing the content.
* ``generate`` renders a prompt, calls
  :meth:`~aid_runtime.gateway.ModelGateway.generate`, and runs the structured path
  when the caller names an output type.
* ``emit`` projects the context into the event fields a caller names.

Every factory takes its inputs **already resolved**: the query string, the argument
mapping, the prompt values. Interpolating a spec template against the context is the
*emitted step body's* job, and a second implementation of it here would be a second
thing to keep in step with the generator's. What is not duplicated is the part that
is the same for every caller: the primitive call, the error contract, the parse, and
the name the result is bound under.

``emit`` is the one leaf whose whole behaviour is reading the context, so
:func:`resolve_source` lives here rather than in a caller: a field's source is a
binding name, optionally followed by one attribute, which is exactly the reference
path the generator derives for the same field.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from json import loads
from typing import Any, Protocol

from pydantic import BaseModel

from aid_runtime.control import CompositeStep
from aid_runtime.errors import PipelineError
from aid_runtime.gateway import ModelGateway
from aid_runtime.pipeline import PipelineContext
from aid_runtime.prompts import PromptRegistry
from aid_runtime.retrieval import RetrievalResult
from aid_runtime.structured import run_structured
from aid_runtime.tools import ToolExecutor
from aid_runtime.types import CompletionRequest, Message, ToolCall

__all__ = [
    "EMITTED_KEY",
    "RetrieverSeam",
    "emit_step",
    "generate_step",
    "resolve_source",
    "retrieve_step",
    "tool_step",
]

#: The context key an ``emit`` step binds its projected payload under.
#:
#: Deliberately *not* in :data:`~aid_runtime.control.RESERVED_KEYS`. That set is
#: mirrored in the generator and pinned against this module by
#: ``packages/generators/py-fastapi/test/control.test.ts``, so a seventh entry would
#: have to be emitted as well -- and the generated applications do not compose
#: their response through this step yet. A generated route keeps building its event
#: object itself; adding the key here would reserve a spec name for a step the
#: emitted apps never call. ``emit_step`` takes the key as an argument so the
#: generator can adopt it under its own name when it does.
EMITTED_KEY = "emitted"


def _named(step: CompositeStep, name: str | None) -> CompositeStep:
    """Name a step's callable, so a trace and ``Pipeline.of`` identify it.

    Separate from :func:`aid_runtime.control._named` because this module builds
    leaves rather than composites, and the two families never share a callable.
    """
    if name is not None:
        step.__name__ = name
    return step


def resolve_source(context: PipelineContext, source: str) -> Any:
    """One ``emit`` field's value: a binding, then at most one attribute below it.

    The one-segment form is the request event's or a scalar binding's whole value;
    the two-segment form is a struct's field. Deeper paths are not accepted, because
    the spec layer's reference paths stop at one field and this resolver exists to
    read exactly what the generator reads.

    A missing binding is :class:`~aid_runtime.errors.PipelineError` naming the key --
    the same refusal ``PipelineContext.require`` makes -- and a missing attribute is
    one naming both the source and the field, because "the field is not there" and
    "the binding is not there" are different mistakes and both mean the response
    would be wrong.

    A field is read off a struct: a model's attribute, or a mapping's key. Both are
    "a struct" here -- a generated application carries typed event models, while a
    context seeded from JSON carries plain mappings -- and the two runtimes must read
    the same struct the same way, so a mapping is not the fallback but a first-class
    shape.
    """
    root, _, attribute = source.partition(".")
    value = context.require(root)
    if not attribute:
        return value
    if "." in attribute:
        raise PipelineError(
            f"emit source {source!r} names more than one attribute below {root!r}; "
            f"a field is read from a binding or one struct below it"
        )
    missing = PipelineError(
        f"emit source {source!r} names the field {attribute!r}, which the "
        f"{root!r} binding does not carry"
    )
    if isinstance(value, Mapping):
        if attribute not in value:
            raise missing
        return value[attribute]
    try:
        return getattr(value, attribute)
    except AttributeError:
        raise missing from None


def emit_step(
    fields: Mapping[str, str],
    *,
    key: str = EMITTED_KEY,
    name: str | None = None,
) -> CompositeStep:
    """Build the event payload from the context, field by field.

    ``fields`` maps each event field to its source, in the order the caller declared
    them: an ordered mapping keeps the payload's own order stable, so a projection
    that reorders its fields is observable rather than invisible. Each source is a
    binding name or a ``binding.attribute`` path, which is the shape the generator
    derives for the same field via ``responsePlan``.

    The step **binds** its payload and does not stop the pipeline. Stopping would
    lose it: Python assigns inside the ``try`` and returns the *pre-step* context on
    :class:`~aid_runtime.pipeline.StopPipeline`, so a stopping step cannot bind
    anything. A generated route does not stop at its emit either -- it runs every
    step and only then builds the response object -- so a later step still runs
    after this one, which is the behaviour a pipeline that composed it would see.
    """

    ordered = tuple((field, source) for field, source in fields.items())

    async def _emit(context: PipelineContext) -> PipelineContext:
        payload = {field: resolve_source(context, source) for field, source in ordered}
        return context.with_values(**{key: payload})

    return _named(_emit, name)


class RetrieverSeam(Protocol):
    """The one method a ``retrieve`` step needs.

    :class:`~aid_runtime.retrieval.Retriever` satisfies it, which is what a generated
    application passes. Stated as a seam rather than as the concrete class so a caller
    that does not own a retriever -- a test, a conformance runner -- can drive the step
    without building an embedding model and a vector store it will never search. The
    step duplicates no part of the search: it decides the query, the ceiling and the
    name, and binding the result is all it adds.
    """

    async def retrieve(self, query: str, *, top_k: int | None = None) -> RetrievalResult: ...


def retrieve_step(
    retriever: RetrieverSeam,
    *,
    binding: str,
    query: str,
    top_k: int | None = None,
    name: str | None = None,
) -> CompositeStep:
    """Search ``retriever`` and bind the cited passages under ``binding``.

    ``top_k`` is passed through rather than resolved here, so ``None`` keeps meaning
    "the binding's own ceiling" exactly as :meth:`Retriever.retrieve` defines it.
    """

    async def _retrieve(context: PipelineContext) -> PipelineContext:
        found: RetrievalResult = await retriever.retrieve(query, top_k=top_k)
        return context.with_values(**{binding: found})

    return _named(_retrieve, name)


def tool_step(
    tools: ToolExecutor,
    *,
    binding: str,
    tool: str,
    arguments: Mapping[str, Any],
    output: type[BaseModel] | None = None,
    name: str | None = None,
) -> CompositeStep:
    """Call ``tool`` and bind what it returned, refusing an error outcome.

    The call id is the binding name, which makes a trace of a tool step name the value
    it produced. An error outcome raises rather than binding a message: a tool the
    model called and that failed is not a value the next step can meaningfully read,
    and the generator's own step raises for the same reason.

    ``output`` is the struct to parse the content into when the spec declared a named
    output; without one the content is bound as parsed JSON, so a tool declaring
    ``string`` binds the string it returned rather than a re-encoded copy.
    """

    async def _tool(context: PipelineContext) -> PipelineContext:
        outcome = await tools.execute(ToolCall(id=binding, name=tool, arguments=dict(arguments)))
        if outcome.is_error:
            raise PipelineError(f"tool {tool} failed: {outcome.content}")
        value = (
            loads(outcome.content)
            if output is None
            else output.model_validate_json(outcome.content)
        )
        return context.with_values(**{binding: value})

    return _named(_tool, name)


def generate_step(
    gateway: ModelGateway,
    prompts: PromptRegistry,
    *,
    binding: str,
    prompt: str,
    model: str,
    values: Mapping[str, str] | None = None,
    version: str | None = None,
    structured: type[BaseModel] | None = None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
    fallbacks: Sequence[str] = (),
    name: str | None = None,
) -> CompositeStep:
    """Render ``prompt``, ask ``model`` for one completion, and bind the answer.

    The call is built once and handed to the structured path as its ``call``, so a
    repair round re-sends an already-rendered prompt instead of rendering again --
    the same closure the generated step emits, and the reason a retry cannot silently
    re-read a binding that changed underneath it.

    ``values`` are the prompt's own values and are passed to the registry unrendered:
    :meth:`PromptRegistry.render` is the one place a template becomes text. With
    ``structured`` the answer is parsed into that type, and a parse failure raises
    after the repair rounds rather than binding a half-valid object.
    """

    async def _generate(context: PipelineContext) -> PipelineContext:
        rendered = prompts.render(prompt, version=version, values=values)

        async def _call(text: str) -> str:
            request = (
                CompletionRequest.prompt(text)
                if temperature is None and max_output_tokens is None
                else CompletionRequest(
                    messages=(Message.user(text),),
                    temperature=temperature,
                    max_output_tokens=max_output_tokens,
                )
            )
            response = await gateway.generate(model, request, fallbacks=fallbacks)
            return response.text

        value: Any = (
            await _call(rendered.text)
            if structured is None
            else await run_structured(_call, structured, rendered.text)
        )
        return context.with_values(**{binding: value})

    return _named(_generate, name)
