/**
 * The `edge` entrypoint: the module a CloudFront origin-request association invokes.
 *
 * A route answers inside an ASGI server and a `batch` job reads stdin, but a Lambda@Edge
 * function is neither: CloudFront hands it one event and takes the response it returns.
 * The event carries the request body when the association includes it, so the module can
 * validate the same request model the route validates and run the same pipeline the route
 * runs. Only the transport differs, which is what keeps an edge request and a route
 * request one contract.
 *
 * The hard constraint is that Lambda@Edge refuses environment variables. The runtime's
 * adapters read their configuration from the environment, so the handler reads a
 * Secrets Manager secret named after the function -- the one identifier CloudFront gives
 * it -- and copies the values into the environment on first use.
 */

import type { IR, PipelineShape } from '@aid-framework/ir';

import { moduleName } from '../names.js';
import { INDENT, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom } from '../template.js';
import { ANONYMOUS_PRINCIPAL, hasBranch } from './control.js';
import { DEPS_BINDING } from './deps.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { hasGuardrails } from './guardrails.js';
import { orderedPipelines } from './order.js';
import {
  callStatement,
  contextSeed,
  factoryName,
  mapping,
  pipelineResponse,
  requestModelName,
} from './pipelines.js';
import { pythonDoc } from './text.js';

export const EDGE_PATH = `${GENERATED_ROOT}/edge.py`;

/** The local the CloudFront request is decoded into. */
const REQUEST = 'request';

/** The detail of a 500 the handler raised itself, before the pipeline ever ran. */
const CONFIG_FAILED = 'the edge function could not read its configuration';

/** The detail of a 500 for a failure the handler did not anticipate. */
const UNHANDLED = 'unhandled failure; see the function log';

/** Whether any deployment is served by CloudFront. */
export function hasEdgeDeployment(ir: IR): boolean {
  return ir.deployments.some((deployment) => deployment.target === 'edge');
}

/**
 * The pipelines an `edge` deployment serves: every HTTP route the spec declares.
 *
 * An edge deployment cannot name one pipeline the way a `batch` deployment does, because
 * CloudFront routes by method and path rather than by job argument. Serving only the HTTP
 * pipelines is what makes the handler's table the same table the app's routers are.
 */
export function edgePipelines(ir: IR): PipelineShape[] {
  return orderedPipelines(ir).filter((pipeline) => pipeline.trigger?.kind === 'http');
}

/** The method and path of a pipeline whose trigger is HTTP, as the route spells them. */
function route(pipeline: PipelineShape): { method: string; path: string } {
  const trigger = pipeline.trigger;
  if (trigger?.kind !== 'http') {
    throw new Error(`edgePipelines returned '${pipeline.id}', whose trigger is not http`);
  }
  return { method: trigger.method.toUpperCase(), path: trigger.path };
}

/**
 * One pipeline, entered the way the route's handler enters it.
 *
 * The handler gets no FastAPI dependency and no response model, so it does both here:
 * validate the body, run the pipeline, and render the answer from the same response
 * fields the route returns. The status is the route's own -- 422 for a body the model
 * rejects, 400 for a guardrail refusal, 502 for a failing step.
 */
function runner(ir: IR, pipeline: PipelineShape, guarded: boolean): string {
  const { type: response, fields } = pipelineResponse(ir, pipeline);
  const run = callStatement(
    'context = await ',
    `${factoryName(pipeline.id)}().run`,
    [mapping(contextSeed(pipeline, DEPS_BINDING), INDENT + INDENT + INDENT)],
    INDENT + INDENT,
  );
  const refusal = guarded
    ? [
        `${INDENT}${INDENT}_blocked = guardrail_block(exc)`,
        `${INDENT}${INDENT}if _blocked is not None:`,
        `${INDENT}${INDENT}${INDENT}return "400", {"detail": str(_blocked)}`,
      ]
    : [];
  return [
    `async def _${moduleName(pipeline.id)}(deps: Deps, payload: object) -> tuple[str, object]:`,
    pythonDoc(
      `Run pipeline \`${pipeline.id}\` and return the status and body of the response.\n\n` +
        'The request model is validated here because no FastAPI dependency does it: a ' +
        'body the pipeline does not accept is a 422, the status the route answers with, ' +
        'rather than a failure inside a step. A failing step is a 502, because the ' +
        'failure is downstream rather than in this request.' +
        (guarded ? ' A step a guardrail stopped is a 400 instead.' : ''),
      INDENT,
    ),
    `${INDENT}try:`,
    `${INDENT}${INDENT}event = ${requestModelName(pipeline.id)}.model_validate(payload)`,
    `${INDENT}except ValidationError as exc:`,
    `${INDENT}${INDENT}return "422", {"detail": json.loads(exc.json(include_url=False))}`,
    `${INDENT}try:`,
    run,
    `${INDENT}except PipelineError as exc:`,
    ...refusal,
    `${INDENT}${INDENT}return "502", {"detail": str(exc)}`,
    `${INDENT}return "200", ${response}(`,
    ...fields.map(([name, value]) => `${INDENT}${INDENT}${name}=${value},`),
    `${INDENT}).model_dump(mode="json")`,
  ].join('\n');
}

/** The routing table, keyed by URI and then by method, in declared-route order. */
function routers(pipelines: readonly PipelineShape[]): string {
  const byPath = new Map<string, [string, string][]>();
  for (const pipeline of pipelines) {
    const { method, path } = route(pipeline);
    const methods = byPath.get(path) ?? [];
    methods.push([method, `_${moduleName(pipeline.id)}`]);
    byPath.set(path, methods);
  }
  return [
    `_RUNNERS: dict[str, dict[str, _Runner]] = {`,
    ...[...byPath.entries()].flatMap(([path, methods]) => [
      `${INDENT}${pythonString(path)}: {`,
      ...methods.map(([method, name]) => `${INDENT}${INDENT}${pythonString(method)}: ${name},`),
      `${INDENT}},`,
    ]),
    '}',
  ].join('\n');
}

export function emitEdge(ir: IR): EmittedFile {
  const pipelines = edgePipelines(ir);
  if (pipelines.length === 0) {
    throw new Error('emitEdge needs an edge deployment and at least one HTTP pipeline');
  }
  const guarded = hasGuardrails(ir);
  const branches = pipelines.some((pipeline) => hasBranch([pipeline]));
  return generated(
    EDGE_PATH,
    assemble([
      HEADER,
      pythonDoc(
        'The `edge` entrypoint: a CloudFront origin-request handler.\n\n' +
          'A Lambda@Edge function is not a server: CloudFront invokes `handler` once and ' +
          'takes the response it returns, so there is no ASGI app and no uvicorn here. The ' +
          'event carries the request body because the association includes it, so this ' +
          'module validates the same request model the route validates and runs the same ' +
          'pipeline the route runs. Only the transport differs, which is what keeps an edge ' +
          'request and a route request one contract.\n\n' +
          'Lambda@Edge refuses environment variables, so the configuration a `serverless` ' +
          'deployment receives through `environment` is read from Secrets Manager on first ' +
          'use. The secret is named after the function, which is the one identifier ' +
          'CloudFront passes as `AWS_LAMBDA_FUNCTION_NAME`; a process that already has its ' +
          'environment set -- a test, or a local run -- is left alone.\n\n' +
          "This module serves the app's HTTP pipeline routes. Agent routes live in " +
          '`app.main:app`, which a Lambda@Edge association does not run.',
      ),
      importBlock([
        [
          'import asyncio',
          'import base64',
          'import json',
          'import os',
          'import traceback',
          importFrom('collections.abc', ['Awaitable', 'Callable']),
          importFrom('typing', ['Any']),
        ],
        [importFrom('aid_runtime', ['PipelineError']), importFrom('pydantic', ['ValidationError'])],
        [
          ...(branches ? [importFrom('.control', [ANONYMOUS_PRINCIPAL])] : []),
          importFrom('.deps', ['Deps', 'get_deps']),
          ...(guarded ? [importFrom('.guardrails', ['guardrail_block'])] : []),
          ...pipelines.map((pipeline) =>
            importFrom(`.pipelines.${moduleName(pipeline.id)}`, [factoryName(pipeline.id)]),
          ),
          importFrom(
            '.requests',
            pipelines.map((pipeline) => requestModelName(pipeline.id)),
          ),
          importFrom(
            '.schemas',
            pipelines.map((pipeline) => pipelineResponse(ir, pipeline).type),
          ),
        ],
      ]),
      [
        '#: The region the configuration secret is created in. Lambda@Edge executes near',
        '#: the viewer, but the function it runs as -- and the secret beside it -- live in',
        '#: `us-east-1`, the only region CloudFront accepts for an association.',
        'CONFIG_REGION = "us-east-1"',
      ].join('\n'),
      [
        '#: The reason phrases CloudFront requires beside each status this handler returns.',
        '_REASONS = {',
        `${INDENT}"200": "OK",`,
        `${INDENT}"400": "Bad Request",`,
        `${INDENT}"404": "Not Found",`,
        `${INDENT}"405": "Method Not Allowed",`,
        `${INDENT}"422": "Unprocessable Content",`,
        `${INDENT}"500": "Internal Server Error",`,
        `${INDENT}"502": "Bad Gateway",`,
        '}',
        '',
        '_configured = False',
        '',
        '',
        'def _configure() -> None:',
        pythonDoc(
          'Read the configuration secret once per container.\n\n' +
            'Lambda@Edge refuses environment variables, so the function reads the secret ' +
            'named after itself and copies each value into the environment the runtime ' +
            'adapters read. `setdefault` keeps a value the process was started with, which ' +
            'is what lets this module run in a test with no AWS client.',
          INDENT,
        ),
        `${INDENT}global _configured`,
        `${INDENT}if _configured:`,
        `${INDENT}${INDENT}return`,
        `${INDENT}secret_id = os.environ.get("AID_EDGE_SECRET") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME")`,
        `${INDENT}if secret_id is not None:`,
        `${INDENT}${INDENT}import boto3  # type: ignore[import-not-found,import-untyped]`,
        '',
        `${INDENT}${INDENT}client = boto3.client("secretsmanager", region_name=CONFIG_REGION)`,
        `${INDENT}${INDENT}answer = client.get_secret_value(SecretId=secret_id)`,
        `${INDENT}${INDENT}for name, value in json.loads(answer["SecretString"]).items():`,
        `${INDENT}${INDENT}${INDENT}os.environ.setdefault(name, str(value))`,
        `${INDENT}_configured = True`,
      ].join('\n'),
      [
        'def _response(status: str, payload: object) -> dict[str, Any]:',
        pythonDoc(
          'Render one CloudFront response, with the body base64-encoded as JSON bytes.\n\n' +
            'CloudFront reads `status` as a string and a base64 body only when ' +
            '`bodyEncoding` says so; a response that is not cached keeps one viewer from ' +
            "receiving another viewer's answer.",
          INDENT,
        ),
        `${INDENT}body = json.dumps(payload, separators=(",", ":")).encode("utf-8")`,
        `${INDENT}return {`,
        `${INDENT}${INDENT}"status": status,`,
        `${INDENT}${INDENT}"statusDescription": _REASONS[status],`,
        `${INDENT}${INDENT}"headers": {`,
        `${INDENT}${INDENT}${INDENT}"cache-control": [{"key": "Cache-Control", "value": "no-store"}],`,
        `${INDENT}${INDENT}${INDENT}"content-type": [`,
        `${INDENT}${INDENT}${INDENT}${INDENT}{"key": "Content-Type", "value": "application/json"},`,
        `${INDENT}${INDENT}${INDENT}],`,
        `${INDENT}${INDENT}},`,
        `${INDENT}${INDENT}"body": base64.b64encode(body).decode("ascii"),`,
        `${INDENT}${INDENT}"bodyEncoding": "base64",`,
        `${INDENT}}`,
      ].join('\n'),
      [
        'def _payload(request: dict[str, Any]) -> object:',
        pythonDoc(
          'The JSON body CloudFront included, decoded from the transport.\n\n' +
            'A function whose association omits `include_body` receives no body at all, ' +
            'so that is a 400 rather than an empty request the pipeline would reject as ' +
            'a missing field.',
          INDENT,
        ),
        `${INDENT}body = ${REQUEST}.get("body")`,
        `${INDENT}if not isinstance(body, dict) or not body.get("data"):`,
        `${INDENT}${INDENT}raise ValueError("the request carries no body")`,
        `${INDENT}data = body["data"]`,
        `${INDENT}encoded = body.get("encoding") == "base64"`,
        `${INDENT}raw = base64.b64decode(data) if encoded else str(data).encode("utf-8")`,
        `${INDENT}return json.loads(raw)`,
      ].join('\n'),
      ...pipelines.map((pipeline) => runner(ir, pipeline, guarded)),
      [
        '_Runner = Callable[[Deps, object], Awaitable[tuple[str, object]]]',
        '',
        routers(pipelines),
      ].join('\n'),
      [
        'def handler(event: dict[str, Any], context: object) -> dict[str, Any]:',
        pythonDoc(
          'Serve one CloudFront origin request.\n\n' +
            '`event` is the CloudFront event whose `cf.request` carries the method, URI ' +
            'and body; `context` is the Lambda context, which this handler does not read. ' +
            'The answer is a CloudFront response, so a refusal is a status the viewer can ' +
            'read rather than an exception CloudFront turns into a 502.',
          INDENT,
        ),
        `${INDENT}try:`,
        `${INDENT}${INDENT}_configure()`,
        `${INDENT}except Exception:`,
        `${INDENT}${INDENT}traceback.print_exc()`,
        `${INDENT}${INDENT}return _response("500", {"detail": ${pythonString(CONFIG_FAILED)}})`,
        `${INDENT}records = event.get("Records")`,
        `${INDENT}${REQUEST} = records[0].get("cf", {}).get("request", {}) if records else {}`,
        `${INDENT}uri = ${REQUEST}.get("uri", "")`,
        `${INDENT}routed = _RUNNERS.get(uri)`,
        `${INDENT}if routed is None:`,
        `${INDENT}${INDENT}return _response("404", {"detail": f"no route for {uri}"})`,
        `${INDENT}method = str(${REQUEST}.get("method", "")).upper()`,
        `${INDENT}run = routed.get(method)`,
        `${INDENT}if run is None:`,
        `${INDENT}${INDENT}return _response("405", {"detail": f"{method} is not allowed for {uri}"})`,
        `${INDENT}try:`,
        `${INDENT}${INDENT}payload = _payload(${REQUEST})`,
        `${INDENT}except (UnicodeDecodeError, ValueError):`,
        `${INDENT}${INDENT}return _response("400", {"detail": "the request body is not JSON"})`,
        `${INDENT}try:`,
        `${INDENT}${INDENT}status, body = asyncio.run(run(get_deps(), payload))`,
        `${INDENT}except Exception:`,
        `${INDENT}${INDENT}traceback.print_exc()`,
        `${INDENT}${INDENT}return _response("500", {"detail": ${pythonString(UNHANDLED)}})`,
        `${INDENT}return _response(status, body)`,
      ].join('\n'),
    ]),
  );
}
