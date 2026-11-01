/**
 * The provider modules: emitted only when a deployment asks for one, constant bytes, and a
 * fixture CI can `tofu validate`.
 *
 * These files are the one place in `infra gen` that emits provider code, so the tests hold
 * them to the reason that was allowed: the bytes must not vary with the plan. A module that
 * varied could not be validated once, and validated-once is the whole argument.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeployPlan } from '@aid-framework/ir';

import { afterAll, describe, expect, it } from 'vitest';

import { emitInfra } from '../src/infra/emit.js';
import {
  CONTAINER_MODULE_DIR,
  emitContainerModule,
  emitProviderModules,
  emitServerlessModule,
  envRoot,
  modulesOf,
  SERVERLESS_MODULE_DIR,
} from '../src/infra/modules/index.js';
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

/** The env root the fixture commits: one that has to satisfy both modules. */
const BOTH = envRoot({ serverless: true, container: true });

/** Enough of a `DeployPlan` to choose a target: the modules ignore everything else. */
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

const CONTAINER = SERVERLESS.replace('target: serverless', 'target: container');

/** The same compiled plan, retargeted, so the container "constant bytes" test is real. */
const AS_CONTAINER = {
  ...SERVING,
  services: SERVING.services.map((service) => ({ ...service, target: 'container' })),
} as unknown as DeployPlan;

/** Biome reads a dollar-brace in a plain string as a botched template. */
const dollar = '$';

function mainOf(files: { path: string; contents: string }[]): string {
  return files.find((file) => file.path.endsWith('/main.tf'))?.contents ?? '';
}

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
    expect(emitServerlessModule(SERVING)).toEqual(emitServerlessModule(planOf('serverless')));
  });

  it('writes Terraform interpolation, not a half-substituted placeholder', () => {
    const main = mainOf(emitServerlessModule(planOf('serverless')));
    expect(main).not.toContain('@{');
    expect(main).toContain(`${dollar}{var.project.namespace}`);
    // A secret is a dynamic reference, so its value never enters state or a plan file.
    expect(main).toContain(`{{resolve:secretsmanager:${dollar}{var.secret_arns`);
  });

  it('grants the function the permission its dynamic references need', () => {
    // Lambda resolves a dynamic reference with the function's own role, so a declared
    // secret is unusable without this statement.
    const main = mainOf(emitServerlessModule(planOf('serverless')));
    expect(main).toContain('secretsmanager:GetSecretValue');
    expect(main).toContain('Resource = values(var.secret_arns)');
  });

  it('makes a legal function name out of a namespace that carries a dot', () => {
    // Lambda names allow letters, digits, hyphens and underscores only.
    const main = mainOf(emitServerlessModule(planOf('serverless')));
    expect(main).toContain('replace(');
    expect(main).toContain('"/[^A-Za-z0-9-_]/"');
    expect(main).toContain('substr(');
  });

  it('refuses what it cannot deliver, in the plan rather than after deploy', () => {
    const main = mainOf(emitServerlessModule(planOf('serverless')));
    // Each refusal is a precondition with a sentence naming the service.
    expect(main).toContain('contains(keys(var.image_uris), each.key)');
    expect(main).toContain('!each.value.streaming');
    expect(main).toContain('contains(keys(var.secret_arns), variable.name)');
    expect(main).toContain('ghcr.io');
  });
});

describe('emitContainerModule', () => {
  it('emits nothing when no deployment targets container', () => {
    expect(emitContainerModule(planOf())).toEqual([]);
    expect(emitContainerModule(planOf('serverless', 'batch', 'edge'))).toEqual([]);
  });

  it('emits the four module files under the generated tree', () => {
    const files = emitContainerModule(planOf('container'));
    expect(files.map((file) => file.path)).toEqual([
      `${CONTAINER_MODULE_DIR}/versions.tf`,
      `${CONTAINER_MODULE_DIR}/variables.tf`,
      `${CONTAINER_MODULE_DIR}/main.tf`,
      `${CONTAINER_MODULE_DIR}/outputs.tf`,
    ]);
    expect(CONTAINER_MODULE_DIR).toBe('infra/generated/modules/container');
  });

  it('is constant: two different plans yield identical bytes', () => {
    expect(emitContainerModule(AS_CONTAINER)).toEqual(emitContainerModule(planOf('container')));
  });

  it('writes Terraform interpolation, not a half-substituted placeholder', () => {
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).not.toContain('@{');
    expect(main).toContain(`${dollar}{var.project.namespace}`);
  });

  it('provisions Fargate behind a load balancer', () => {
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('aws_ecs_task_definition');
    expect(main).toContain('aws_ecs_service');
    expect(main).toContain('"FARGATE"');
    expect(main).toContain('aws_lb_target_group');
    expect(main).toContain('aws_lb_listener_rule');
    // The generated Dockerfile listens on 8080; the module must agree with it.
    expect(main).toContain('containerPort = 8080');
    expect(main).toContain('port        = 8080');
  });

  it('registers a routed task with its target group', () => {
    // Without this block the listener forwards to a group with no targets: the apply
    // succeeds and every request times out, which is the worst way to be wrong.
    // The block name is singular in the AWS provider; `load_balancers` does not exist.
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('dynamic "load_balancer"');
    expect(main).not.toContain('dynamic "load_balancers"');
    expect(main).toContain('target_group_arn = aws_lb_target_group.service[each.key].arn');
    expect(main).toContain('container_name   = "app"');
    expect(main).toContain('container_port   = 8080');
  });

  it('lets the load balancer reach the task and nothing else', () => {
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('referenced_security_group_id');
  });

  it('refuses a path two services claim, since an ALB cannot route by method', () => {
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('length(local.route_pairs) == length(local.paths)');
    expect(main).toContain('routes by path, not by method');
    expect(main).toContain('contains(keys(var.image_uris), each.key)');
    expect(main).toContain('contains(keys(var.secret_arns), variable.name)');
    // Networking is the other thing an empty input makes invalid rather than absent.
    expect(main).toContain('length(local.public_subnet_ids) >= 2');
    expect(main).toContain('length(local.private_subnet_ids) >= 2');
    expect(main).toContain('var.vpc_cidr != ""');
  });

  it('refuses a load balancer with fewer than two subnets', () => {
    // AWS rejects a one-subnet ALB, so the refusal belongs in the plan, where the
    // message can name the input to fix.
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('length(local.public_subnet_ids) >= 2');
  });

  it('refuses to guess a network range', () => {
    // A CIDR is an operator decision, so it is a required input whenever the module
    // builds the VPC -- and the module states no range of its own.
    const files = emitContainerModule(planOf('container'));
    expect(mainOf(files)).toContain('var.vpc_cidr != ""');

    const vars = files.find((file) => file.path.endsWith('/variables.tf'))?.contents ?? '';
    expect(vars).toMatch(/variable "vpc_cidr"[\s\S]{0,200}default\s+= ""/);
    expect(vars).not.toMatch(/variable "vpc_cidr"[\s\S]{0,200}\d+\.\d+\.\d+\.\d+/);
  });

  it('streams, which is the reason to choose a container over serverless', () => {
    // No streaming precondition here: a load balancer delivers a body incrementally.
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).not.toContain('!each.value.streaming');
  });

  it('tolerates a service without a health route', () => {
    // The generated app answers 404 on an unknown path, and a 404 still proves the
    // task is serving, so the probe accepts any answer below 500.
    const main = mainOf(emitContainerModule(planOf('container')));
    expect(main).toContain('matcher = "200-499"');
  });
});

describe('envRoot', () => {
  it('declares only the business inputs a present module reads', () => {
    const serverless = envRoot({ serverless: true, container: false });
    expect(serverless.variables).toContain('variable "sizing"');
    expect(serverless.variables).not.toContain('variable "container_sizing"');
    expect(serverless.main).toContain('module "serverless"');
    expect(serverless.main).not.toContain('module "container"');

    const container = envRoot({ serverless: false, container: true });
    expect(container.variables).toContain('variable "container_sizing"');
    expect(container.variables).not.toContain('variable "sizing"');
    expect(container.main).toContain('module "container"');
    expect(container.main).not.toContain('module "serverless"');
  });

  it('calls both modules when a plan targets both', () => {
    expect(BOTH.main).toContain('module "serverless"');
    expect(BOTH.main).toContain('module "container"');
    expect(BOTH.main).toContain('source = "../../generated/modules/serverless"');
    expect(BOTH.main).toContain('source = "../../generated/modules/container"');
    expect(BOTH.main).not.toContain('@{');
  });

  it('says so rather than inventing a module when neither target is present', () => {
    const none = envRoot({ serverless: false, container: false });
    expect(none.main).not.toContain('module "');
    expect(none.main).toContain('no provider module was');
    expect(none.variables).not.toContain('variable "image_uris"');
  });

  it('separates blocks with one blank line, never two', () => {
    for (const rendered of [BOTH.main, BOTH.variables]) {
      expect(rendered).not.toMatch(/\n\n\n/);
      expect(rendered).not.toMatch(/\{\n\n/);
    }
    expect(BOTH.main).toContain('}\n\nmodule "container"');
    expect(BOTH.main).toContain('}\n\noutput "serverless_endpoint"');
  });

  it('is pure: the same module set yields the same bytes', () => {
    expect(envRoot({ serverless: true, container: true })).toEqual(BOTH);
  });
});

describe('modulesOf, the seam emit.ts reads', () => {
  it('reports the platforms a plan targets', () => {
    expect(modulesOf(planOf())).toEqual({ serverless: false, container: false });
    expect(modulesOf(planOf('serverless', 'container'))).toEqual({
      serverless: true,
      container: true,
    });
    // A target with no module yet must not be mistaken for one that has a module.
    expect(modulesOf(planOf('batch', 'edge'))).toEqual({ serverless: false, container: false });
  });

  it('emits every module a plan needs in one call', () => {
    const paths = emitProviderModules(planOf('serverless', 'container')).map((file) => file.path);
    expect(paths).toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
    expect(paths).toContain(`${CONTAINER_MODULE_DIR}/main.tf`);
    expect(paths).toHaveLength(8);
  });
});

describe('infra gen with a serverless deployment', () => {
  it('writes the module, and the README points at it', () => {
    const made = scratch(SERVERLESS);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    const walked = made.walk();
    for (const name of ['versions.tf', 'variables.tf', 'main.tf', 'outputs.tf']) {
      expect(walked, name).toContain(`${SERVERLESS_MODULE_DIR}/${name}`);
    }
    expect(made.read(`${SERVERLESS_MODULE_DIR}/main.tf`)).toContain('aws_lambda_function');
    expect(walked.filter((path) => path.includes('/modules/container/'))).toEqual([]);

    const readme = made.read('infra/generated/README.md');
    expect(readme).toContain('modules/serverless/');
    expect(readme).toContain('module "serverless"');
    expect(readme).not.toContain('modules/container/');
  });

  it('writes no module when the plan targets neither platform', () => {
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
});

describe('infra gen with a container deployment', () => {
  it('writes the container module and no serverless one', () => {
    const made = scratch(CONTAINER);
    expect(aid(made, ['infra', 'gen']).code).toBe(0);

    expect(made.walk()).toContain(`${CONTAINER_MODULE_DIR}/main.tf`);
    expect(made.walk().filter((path) => path.includes('/modules/serverless/'))).toEqual([]);
    expect(made.read(`${CONTAINER_MODULE_DIR}/main.tf`)).toContain('aws_ecs_service');

    const readme = made.read('infra/generated/README.md');
    expect(readme).toContain('modules/container/');
    expect(readme).toContain('module "container"');
    expect(readme).not.toContain('variable "sizing"');
  });
});

describe('the validate fixture', () => {
  /** CI runs `tofu validate` here, so the fixture must be exactly what is emitted. */
  it('matches each emitted module byte for byte', () => {
    const cases = [
      { dir: SERVERLESS_MODULE_DIR, files: emitServerlessModule(planOf('serverless')) },
      { dir: CONTAINER_MODULE_DIR, files: emitContainerModule(planOf('container')) },
    ];
    for (const { dir, files } of cases) {
      expect(files).toHaveLength(4);
      const platform = dir.slice(dir.lastIndexOf('/') + 1);
      for (const file of files) {
        const name = file.path.slice(dir.length + 1);
        const fixture = readFileSync(join(FIXTURE, 'generated', 'modules', platform, name), 'utf8');
        expect(fixture, `${platform}/${name}`).toBe(file.contents);
      }
    }
  });

  it('matches the documented env root byte for byte', () => {
    const variables = readFileSync(join(FIXTURE, 'envs', 'dev', 'variables.tf'), 'utf8');
    const main = readFileSync(join(FIXTURE, 'envs', 'dev', 'main.tf'), 'utf8');
    expect(variables).toBe(BOTH.variables);
    expect(main).toBe(BOTH.main);
  });

  it('is wired to the modules the emitter writes', () => {
    // A fixture that pointed anywhere else would validate a module nobody gets.
    const main = readFileSync(join(FIXTURE, 'envs', 'dev', 'main.tf'), 'utf8');
    expect(main).toContain('source = "../../generated/modules/serverless"');
    expect(main).toContain('source = "../../generated/modules/container"');
  });
});

describe('the whole derived tree', () => {
  it('keeps the module in the same single emission', () => {
    const files = emitInfra(SERVING);
    expect(files.map((file) => file.path)).toContain(`${SERVERLESS_MODULE_DIR}/main.tf`);
  });
});
