/**
 * The serverless provider module: emitted only when a deployment asks for it, constant
 * bytes, and a fixture CI can `tofu validate`.
 *
 * The module is the one place in `infra gen` that emits provider code, so the tests hold
 * it to the reason that was allowed: the bytes must not vary with the plan. A module that
 * varied could not be validated once, and validated-once is the whole argument.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeployPlan } from '@aid-framework/ir';

import { afterAll, describe, expect, it } from 'vitest';

import { emitInfra } from '../src/infra/emit.js';
import {
  ENV_ROOT_MAIN_TF,
  ENV_ROOT_VARIABLES_TF,
  emitServerlessModule,
  SERVERLESS_MODULE_DIR,
} from '../src/infra/modules.js';
import { aid, diagnosticsOf, project } from './helpers.js';

const created: ReturnType<typeof project>[] = [];

afterAll(() => {
  for (const made of created) made.close();
});

function scratch(spec?: string) {
  const made = spec === undefined ? project() : project(spec);
  created.push(made);
  return made;
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'infra');

/** Enough of a `DeployPlan` to choose a target: the module ignores everything else. */
function planOf(...targets: string[]): DeployPlan {
  return {
    services: targets.map((target, index) => ({ id: `svc${index}`, target })),
  } as unknown as DeployPlan;
}

/** A plan the spec compiler would produce, with one route and one secret env. */
const SERVING = {
  project: { name: 'ping', namespace: 'aid.test' },
  services: [
    {
      id: 'api',
      target: 'serverless',
      streaming: false,
      endpoints: [{ pipeline: 'ping', method: 'GET', path: '/ping' }],
      env: [
        { name: 'LOG_LEVEL', secret: false, from: 'spec', value: 'info' },
        { name: 'OPENAI_API_KEY', secret: true, from: 'deployment' },
      ],
      secrets: ['OPENAI_API_KEY'],
      providers: [],
      ingest: [],
    },
  ],
  stores: [],
  tasks: [],
  alarms: [],
} as unknown as DeployPlan;

const SERVERLESS = `specVersion: "0.2"
project:
  name: ping
  namespace: aid.test
  targets: [py-fastapi]
models:
  small:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema]
    apiKeyEnv: OPENAI_API_KEY
prompts:
  answer:
    version: 1
    model: small
    template: "Answer the request."
    output:
      kind: text
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: rejected.
      log: true
deployments:
  api:
    target: serverless
    secrets: [OPENAI_API_KEY]
pipelines:
  ping:
    trigger:
      http:
        method: get
        path: /ping
    steps:
      - generate:
          prompt: answer
          as: reply
`;

describe('emitServerlessModule', () => {
  it('emits nothing when no deployment targets serverless', () => {
    expect(emitServerlessModule(planOf())).toEqual([]);
    expect(emitServerlessModule(planOf('container', 'batch', 'edge'))).toEqual([]);
  });

  it('emits the four module files under the generated tree', () => {
    const files = emitServerlessModule(planOf('serverless'));
    expect(files.map((file) => file.path)).toEqual([
      `${SERVERLESS_MODULE_DIR}/versions.tf`,
      `${SERVERLESS_MODULE_DIR}/variables.tf`,
      `${SERVERLESS_MODULE_DIR}/main.tf`,
      `${SERVERLESS_MODULE_DIR}/outputs.tf`,
    ]);
    expect(SERVERLESS_MODULE_DIR).toBe('infra/generated/modules/serverless');
  });

  it('is constant: two different plans yield identical bytes', () => {
    const first = emitServerlessModule(planOf('serverless'));
    const second = emitServerlessModule(SERVING);
    expect(second).toEqual(first);
  });

  it('writes Terraform interpolation, not a half-substituted placeholder', () => {
    const main = emitServerlessModule(planOf('serverless')).find((file) =>
      file.path.endsWith('/main.tf'),
    );
    // Biome reads `${` in a plain string as a botched template; the dollar is spelled once
    // so the assertions can name the interpolation the emitter is supposed to write.
    const dollar = '$';
    expect(main).toBeDefined();
    expect(main?.contents).not.toContain('@{');
    expect(main?.contents).toContain(
      `${dollar}{var.project.namespace}-${dollar}{var.project.name}`,
    );
    // A secret is a dynamic reference, so its value never enters state or a plan file.
    expect(main?.contents).toContain(`{{resolve:secretsmanager:${dollar}{var.secret_arns`);
  });

  it('refuses what it cannot deliver, in the plan rather than after deploy', () => {
    const main =
      emitServerlessModule(planOf('serverless')).find((file) => file.path.endsWith('/main.tf'))
        ?.contents ?? '';
    // Each refusal is a precondition with a sentence naming the service.
    expect(main).toContain('contains(keys(var.image_uris), each.key)');
    expect(main).toContain('!each.value.streaming');
    expect(main).toContain('contains(keys(var.secret_arns), variable.name)');
    expect(main).toContain('ghcr.io');
  });
});

describe('infra gen with a serverless deployment', () => {
  it('writes the module, and the manifest records it', () => {
    const made = scratch(SERVERLESS);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const walked = made.walk();
    for (const name of ['versions.tf', 'variables.tf', 'main.tf', 'outputs.tf']) {
      expect(walked, name).toContain(`${SERVERLESS_MODULE_DIR}/${name}`);
    }
    expect(made.read(`${SERVERLESS_MODULE_DIR}/main.tf`)).toContain('aws_lambda_function');
    // The README points at the module and shows the env root the user must own.
    const readme = made.read('infra/generated/README.md');
    expect(readme).toContain('modules/serverless/');
    expect(readme).toContain(ENV_ROOT_MAIN_TF.trimEnd().split('\n')[2]);
  });

  it('writes no module when the plan never targets serverless', () => {
    const made = scratch(`specVersion: "0.2"
project:
  name: tiny
  targets: [py-fastapi]
`);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    expect(made.walk().filter((path) => path.includes('/modules/'))).toEqual([]);
    expect(made.read('infra/generated/README.md')).toContain('No provider module is generated');
  });

  it('treats a hand-edited module as drift', () => {
    const made = scratch(SERVERLESS);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const path = `${SERVERLESS_MODULE_DIR}/main.tf`;
    made.write(path, `${made.read(path)}# hand edit\n`);

    const check = aid(made, ['infra', 'gen', '--check', '--json']);
    expect(check.code).toBe(1);
    // A hand-edited module is a conflict, not merely an out-of-date file: the tool will
    // not overwrite it, which is the difference between a warning and a refusal.
    expect(diagnosticsOf(check).map((d) => d.code)).toContain('generator/generated-drift');
  });

  it('a container deployment gains no module either', () => {
    const made = scratch(`specVersion: "0.2"
project:
  name: boxed
  namespace: aid.test
  targets: [py-fastapi]
models:
  small:
    provider: openai
    modelId: gpt-4o-mini
    capabilities: [json-schema]
    apiKeyEnv: OPENAI_API_KEY
prompts:
  answer:
    version: 1
    model: small
    template: "Answer the request."
    output:
      kind: text
guardrails:
  inbound:
    stages: [input]
    policies: [prompt-injection]
    action: block
    onFail:
      message: rejected.
      log: true
deployments:
  api:
    target: container
    secrets: [OPENAI_API_KEY]
pipelines:
  ping:
    trigger:
      http:
        method: get
        path: /ping
    steps:
      - generate:
          prompt: answer
          as: reply
`);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    expect(made.walk().filter((path) => path.includes('/modules/'))).toEqual([]);
  });
});

describe('the validate fixture', () => {
  /** CI runs `tofu validate` here, so the fixture must be exactly what is emitted. */
  it('matches the emitted module byte for byte', () => {
    for (const file of emitServerlessModule(planOf('serverless'))) {
      const name = file.path.slice(SERVERLESS_MODULE_DIR.length + 1);
      const fixture = readFileSync(
        join(FIXTURE, 'generated', 'modules', 'serverless', name),
        'utf8',
      );
      expect(fixture, name).toBe(file.contents);
    }
  });

  it('matches the documented env root byte for byte', () => {
    const variables = readFileSync(join(FIXTURE, 'envs', 'dev', 'variables.tf'), 'utf8');
    const main = readFileSync(join(FIXTURE, 'envs', 'dev', 'main.tf'), 'utf8');
    expect(variables).toBe(ENV_ROOT_VARIABLES_TF);
    expect(main).toBe(ENV_ROOT_MAIN_TF);
  });

  it('is wired to the module the emitter writes', () => {
    // A fixture that pointed anywhere else would validate a module nobody gets.
    const main = readFileSync(join(FIXTURE, 'envs', 'dev', 'main.tf'), 'utf8');
    expect(main).toContain('source = "../../generated/modules/serverless"');
  });
});

describe('the whole derived tree', () => {
  it('keeps the module in the same single emission', () => {
    const files = emitInfra(SERVING);
    expect(files.map((file) => file.path)).toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
  });
});
