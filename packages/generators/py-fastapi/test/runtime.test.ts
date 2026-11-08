/**
 * The managed-runtime adapter: `app/generated/runtime_app.py`, and the image that runs it.
 *
 * A platform-hosted agent is called by the platform, not by a load balancer, so the
 * container has to serve two routes the spec does not declare: the platform's health check
 * and its invocation route. The claim worth testing is not that those two routes exist but
 * that the invocation *reaches the application's own handler*: the cost ceiling, the trace
 * span, the eval hook and every refusal live in that handler and its middleware, and an
 * adapter that answered directly would silently drop all four.
 *
 * So the tests read the emitted module for the dispatch shape (`await app(scope, ...)`)
 * and for the absence of a second way in, and they check that the Dockerfile points at the
 * adapter only when a deployment actually declares a runtime -- the file and the command
 * have to agree, because a CMD naming a module that was not generated fails at boot.
 */

import { describe, expect, it } from 'vitest';

import { DOCKERFILE_PATH, emitDockerfile } from '../src/emit/dockerfile.js';
import {
  emitRuntimeApp,
  hasManagedRuntime,
  RUNTIME_APP_PATH,
  runtimePaths,
} from '../src/emit/runtime.js';
import { buildForSpecText, exampleSpecText } from './helpers.js';

/** The example plus a managed runtime on its one container deployment. */
function specWithRuntime(platform = 'aws-agentcore'): string {
  return (
    exampleSpecText()
      .replace('specVersion: "0.2"', 'specVersion: "0.13"')
      // The adapter answers one request with one response, so a streamed route would still
      // be correct HTTP but no longer incremental; the test spec asks for the plain shape.
      .replace('    streaming: true', '    streaming: false')
      .replace(
        '    secrets: [OPENAI_API_KEY]',
        `    secrets: [OPENAI_API_KEY]\n    runtime:\n      platform: ${platform}`,
      )
  );
}

function runtimePlan() {
  return buildForSpecText(specWithRuntime(), 'app.spec.yaml');
}

describe('a managed runtime', () => {
  it('is planned only when a deployment declares one', () => {
    const plain = buildForSpecText(exampleSpecText(), 'app.spec.yaml');
    expect(hasManagedRuntime(plain.ir)).toBe(false);
    expect(plain.plan.files.map((file) => file.path)).not.toContain(RUNTIME_APP_PATH);

    const managed = runtimePlan();
    expect(hasManagedRuntime(managed.ir)).toBe(true);
    const adapter = managed.plan.files.find((file) => file.path === RUNTIME_APP_PATH);
    expect(adapter?.owner).toBe('generated');
  });

  it('serves the platform health check the platform polls', () => {
    const { content } = emitRuntimeApp(runtimePlan().ir);

    expect(content).toContain('@app.get("/ping")');
    expect(content).toContain('"status": "Healthy"');
  });

  it('replays an invocation through the app instead of answering it', () => {
    const { content } = emitRuntimeApp(runtimePlan().ir);

    // The app object is the application's own, mounted by `app.main`, and the invocation
    // route calls it as an ASGI app -- so the route's model, middleware, meter and span
    // all run. A generated adapter that imported a pipeline function instead would be a
    // second entrypoint, and the second one would be the unmetered one.
    expect(content).toContain('from app.main import app');
    expect(content).toContain('await app(scope, receive, send)');
    expect(content).not.toContain('from app.generated.pipelines');
    expect(content).toContain('@app.post("/invocations")');
    expect(content).toContain('body = await request.body()');
  });

  it('names the single HTTP route the platform invocation carries', () => {
    const ir = runtimePlan().ir;
    expect(runtimePaths(ir)).toEqual(['/tickets/answer']);

    // `PATHS` is emitted as a tuple so the literal route is visible in the file a reader
    // opens, not resolved at import time from the pipeline registry.
    expect(emitRuntimeApp(ir).content).toContain('PATHS: tuple[str, ...] = ("/tickets/answer",)');
  });

  it('refuses to pick a route when the spec leaves more than one', () => {
    const ir = runtimePlan().ir;
    const doubled = {
      ...ir,
      pipelines: [
        ...ir.pipelines,
        { ...(ir.pipelines[0] as (typeof ir.pipelines)[number]), id: 'second_http' },
      ],
    };
    // The spec already refuses this; the emitter asserts the invariant rather than
    // choosing one of the two silently if that refusal is ever relaxed.
    expect(() => emitRuntimeApp(doubled)).toThrow(/exactly one HTTP route/);
  });

  it('starts the image on the adapter, and keeps the plain app when there is none', () => {
    const managed = emitDockerfile(runtimePlan().ir).content;
    expect(managed).toContain('exec uvicorn app.generated.runtime_app:app --host 0.0.0.0');

    const plain = emitDockerfile(buildForSpecText(exampleSpecText(), 'app.spec.yaml').ir).content;
    expect(plain).toContain('exec uvicorn app.main:app --host 0.0.0.0');
    expect(plain).not.toContain('runtime_app');
    expect(plain).not.toContain('/ping');
  });

  it('keeps the image documented as the project it builds', () => {
    const { content } = emitDockerfile(runtimePlan().ir);
    expect(content).toContain(`-f ${DOCKERFILE_PATH} -t support-copilot .`);
  });
});
