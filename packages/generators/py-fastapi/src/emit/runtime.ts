/**
 * The managed-runtime entrypoint: the routes a platform-hosted agent has to serve.
 *
 * AgentCore and the Agent Platform both call the container themselves, so the image needs
 * `GET /ping` and an invocation route on top of the routes the spec declares. Adding them
 * to `app/main.py` is not an option: that file belongs to the application. Instead this
 * module imports the app the application built and adds the two routes to *that same
 * object*, then dispatches an invocation through its ASGI surface -- so the cost ceiling,
 * the trace span, the eval hook and every refusal run on the invocation path because it is
 * the HTTP path. A platform deployment that skipped them would be a regression wearing a
 * feature's name.
 */

import type { IR } from '@aid-framework/ir';

import { INDENT, pythonString } from '../python.js';
import { assemble, HEADER, importBlock, importFrom, tupleLiteral } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { orderedPipelines } from './order.js';
import { pythonDoc } from './text.js';

export const RUNTIME_APP_PATH = `${GENERATED_ROOT}/runtime_app.py`;

/** Whether any deployment hands its process to a managed platform. */
export function hasManagedRuntime(ir: IR): boolean {
  return ir.deployments.some((deployment) => deployment.runtime !== undefined);
}

/**
 * The HTTP paths a managed deployment serves, in canonical order.
 *
 * A runtime app is one process behind one platform address, so the platform's invocation
 * has to land on exactly one route. The spec refuses a runtime deployment that does not
 * leave one HTTP pipeline, and this guard keeps the emitter from picking silently if that
 * refusal is ever loosened.
 */
export function runtimePaths(ir: IR): string[] {
  const paths = orderedPipelines(ir)
    .flatMap((pipeline) => (pipeline.trigger.kind === 'http' ? [pipeline.trigger.path] : []))
    .sort();
  if (paths.length !== 1) {
    throw new Error(
      `emitRuntimeApp needs exactly one HTTP route for a managed runtime, found ${paths.length}`,
    );
  }
  return paths;
}

/** The route table, kept flat while it fits. */
function pathsLiteral(paths: readonly string[]): string {
  const prefix = 'PATHS: tuple[str, ...] = ';
  // `tupleLiteral` only counts the prefix toward the width; the caller writes it out.
  return `${prefix}${tupleLiteral(paths.map(pythonString), '', prefix)}`;
}

export function emitRuntimeApp(ir: IR): EmittedFile {
  const paths = runtimePaths(ir);
  const route = paths[0] ?? '';

  const ping = [
    '@app.get("/ping")',
    'def ping() -> dict[str, str]:',
    pythonDoc('The health check the platform polls before it routes traffic to the agent.', INDENT),
    `${INDENT}return {"status": "Healthy"}`,
  ].join('\n');

  const invoke = [
    '@app.post("/invocations")',
    'async def invoke(request: Request) -> Response:',
    pythonDoc(
      'Answer one platform invocation by replaying it through this app. The body is passed ' +
        'through untouched, so the route validates the same model and runs the same pipeline ' +
        'it would for an HTTP caller.',
      INDENT,
    ),
    `${INDENT}body = await request.body()`,
    `${INDENT}content_type = request.headers.get("content-type", "application/json")`,
    `${INDENT}return await _through(body, content_type)`,
  ].join('\n');

  const through = [
    'async def _through(body: bytes, content_type: str) -> Response:',
    pythonDoc(
      'Send a buffered request into this app and collect the response. Calling the ASGI app ' +
        'in process -- rather than this process calling itself over the network -- is what ' +
        'keeps the middleware, the meter and the trace on the invocation path.',
      INDENT,
    ),
    `${INDENT}scope: dict[str, Any] = {`,
    `${INDENT}${INDENT}"type": "http",`,
    `${INDENT}${INDENT}"asgi": {"version": "3.0"},`,
    `${INDENT}${INDENT}"http_version": "1.1",`,
    `${INDENT}${INDENT}"method": "POST",`,
    `${INDENT}${INDENT}"scheme": "http",`,
    `${INDENT}${INDENT}"path": PATHS[0],`,
    `${INDENT}${INDENT}"raw_path": PATHS[0].encode(),`,
    `${INDENT}${INDENT}"query_string": b"",`,
    `${INDENT}${INDENT}"root_path": "",`,
    `${INDENT}${INDENT}"headers": [(b"content-type", content_type.encode("latin-1"))],`,
    `${INDENT}${INDENT}"client": ("agent-runtime", 0),`,
    `${INDENT}${INDENT}"server": ("agent-runtime", 0),`,
    `${INDENT}}`,
    `${INDENT}status = 500`,
    `${INDENT}response_body = b""`,
    `${INDENT}response_type = "application/json"`,
    `${INDENT}consumed = False`,
    '',
    `${INDENT}async def receive() -> dict[str, Any]:`,
    `${INDENT}${INDENT}nonlocal consumed`,
    `${INDENT}${INDENT}if consumed:`,
    `${INDENT}${INDENT}${INDENT}return {"type": "http.disconnect"}`,
    `${INDENT}${INDENT}consumed = True`,
    `${INDENT}${INDENT}return {"type": "http.request", "body": body, "more_body": False}`,
    '',
    `${INDENT}async def send(message: dict[str, Any]) -> None:`,
    `${INDENT}${INDENT}nonlocal status, response_body, response_type`,
    `${INDENT}${INDENT}if message["type"] == "http.response.start":`,
    `${INDENT}${INDENT}${INDENT}status = message["status"]`,
    `${INDENT}${INDENT}${INDENT}for key, value in message.get("headers", []):`,
    `${INDENT}${INDENT}${INDENT}${INDENT}if key == b"content-type":`,
    `${INDENT}${INDENT}${INDENT}${INDENT}${INDENT}response_type = value.decode("latin-1")`,
    `${INDENT}${INDENT}elif message["type"] == "http.response.body":`,
    `${INDENT}${INDENT}${INDENT}response_body += message.get("body", b"")`,
    '',
    `${INDENT}await app(scope, receive, send)`,
    `${INDENT}return Response(`,
    `${INDENT}${INDENT}content=response_body,`,
    `${INDENT}${INDENT}status_code=status,`,
    `${INDENT}${INDENT}headers={"content-type": response_type},`,
    `${INDENT})`,
  ].join('\n');

  return generated(
    RUNTIME_APP_PATH,
    assemble([
      HEADER,
      pythonDoc(
        `The platform contract for \`${ir.project.name}\`: \`/ping\` plus an invocation route ` +
          `that replays a request into the app at \`${route}\`.`,
      ),
      importBlock([
        ['from typing import Any'],
        [importFrom('fastapi', ['Request', 'Response'])],
        // Absolute, not relative: the app package is the one `app.main:app` names, and a
        // generated module that reached it by a different path could import a second copy.
        [importFrom('app.main', ['app'])],
      ]),
      pathsLiteral(paths),
      ping,
      invoke,
      through,
    ]),
  );
}
