'use strict';

/**
 * The synth fixture: the smallest CDK app that consumes the generated construct.
 *
 * It reads the committed `context.json`, which is what `aid infra gen` writes for a
 * serverless project, and `inputs.json`, which stands in for the business inputs an env
 * root supplies. CI runs `cdk synth` here, so a construct that stops compiling -- or a
 * generated file that drifts from the one `tofu` validates -- fails before merge.
 *
 * `cdk synth` also exits 0 for an empty stack, so the app asserts the shape it expects:
 * one Lambda and one HTTP API route, the same resources the HCL module renders.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cdk = require('aws-cdk-lib');
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2');
const bedrock = require('aws-cdk-lib/aws-bedrock');
const lambda = require('aws-cdk-lib/aws-lambda');
const aoss = require('aws-cdk-lib/aws-opensearchserverless');

const ecs = require('aws-cdk-lib/aws-ecs');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const { addContainer } = require('../../generated/cdk/container.cjs');
const { addKnowledgeBase } = require('../../generated/cdk/knowledge-base.cjs');
const { addServerless } = require('../../generated/cdk/serverless.cjs');

const here = path.join(__dirname, '..');
const context = JSON.parse(fs.readFileSync(path.join(here, 'context.json'), 'utf8'));
const inputs = JSON.parse(fs.readFileSync(path.join(here, 'inputs.json'), 'utf8'));

const app = new cdk.App();
const stack = new cdk.Stack(app, 'AidFixture', {
  env: { account: '111111111111', region: 'us-east-1' },
});

// The context is written before anything is applied, so it carries an empty id and ARN
// for every base; the construct's return value is the only place they exist at synth time.
const bases = addKnowledgeBase(stack, context, inputs);
const business = Object.assign({}, inputs, { knowledgeBases: bases });
addServerless(stack, context, business);
const edge = addContainer(stack, context, business);
assert.ok(edge.endpoint.startsWith('http://'), 'expected the load balancer endpoint');
assert.ok(edge.services.worker, 'expected the container service to be created');

const nodes = stack.node.findAll();
const functions = nodes.filter((node) => node instanceof lambda.CfnFunction);
const routes = nodes.filter((node) => node instanceof apigwv2.CfnRoute);
const guardrails = nodes.filter((node) => node instanceof bedrock.CfnGuardrail);
const versions = nodes.filter((node) => node instanceof bedrock.CfnGuardrailVersion);

assert.strictEqual(functions.length, 1, 'expected one Lambda function');
assert.strictEqual(routes.length, 1, 'expected one HTTP API route');
assert.strictEqual(routes[0].routeKey, 'GET /ping', 'expected the spec route key');

// The plan names the engine and carries a policy block, so the construct owns a guardrail
// and pins the app to its numbered version rather than DRAFT.
assert.strictEqual(guardrails.length, 1, 'expected one managed guardrail');
assert.strictEqual(versions.length, 1, 'expected one guardrail version');
const entity = guardrails[0].sensitiveInformationPolicyConfig.piiEntitiesConfig[0];
assert.strictEqual(entity.type, 'EMAIL', 'expected the spec PII entity');
assert.strictEqual(entity.action, 'BLOCK', 'expected the spec PII action');

// The app reads the guardrail from its environment, the same two names the HCL module
// injects, so the Python runtime's managed client finds it either way.
assert.ok(
  functions[0].environment.variables.BEDROCK_GUARDRAIL_ID,
  'expected the guardrail id in the function environment',
);
assert.ok(
  functions[0].environment.variables.BEDROCK_GUARDRAIL_VERSION,
  'expected the guardrail version in the function environment',
);

// The spec binds the `docs` retriever to the one Bedrock base, so the app learns that
// base's id under the name the runtime computes, and its role may call `Retrieve`.
const baseVars = functions[0].environment.variables;
assert.ok(
  baseVars.BEDROCK_KNOWLEDGE_BASE_HANDBOOK,
  'expected the knowledge base id in the function environment',
);

const collections = nodes.filter((node) => node instanceof aoss.CfnCollection);
const knowledgeBases = nodes.filter((node) => node instanceof bedrock.CfnKnowledgeBase);
const dataSources = nodes.filter((node) => node instanceof bedrock.CfnDataSource);

assert.strictEqual(collections.length, 1, 'expected one provisioned collection');
assert.strictEqual(knowledgeBases.length, 1, 'expected one knowledge base');
assert.strictEqual(dataSources.length, 1, 'expected one data source');
assert.strictEqual(
  dataSources[0].dataSourceConfiguration.type,
  'S3',
  'expected an S3 data source',
);
assert.strictEqual(
  dataSources[0].vectorIngestionConfiguration.chunkingConfiguration.chunkingStrategy,
  'FIXED_SIZE',
  'expected the spec chunking strategy',
);
assert.deepStrictEqual(
  dataSources[0].dataSourceConfiguration.s3Configuration.inclusionPrefixes,
  ['handbook'],
  'expected the spec key prefix without its trailing slash',
);
assert.strictEqual(collections[0].type, 'VECTORSEARCH', 'expected a vector collection');

// The container construct renders one task definition and one service per `container`
// deployment, one target group each, and one listener rule per declared path -- sorted,
// so the same context always assigns the same priorities.
const taskDefinitions = nodes.filter((node) => node instanceof ecs.CfnTaskDefinition);
const services = nodes.filter((node) => node instanceof ecs.CfnService);
const listenerRules = nodes.filter((node) => node instanceof elbv2.CfnListenerRule);

assert.strictEqual(taskDefinitions.length, 1, 'expected one task definition');
assert.strictEqual(services.length, 1, 'expected one ECS service');
assert.strictEqual(services[0].desiredCount, 2, 'expected the spec desired count');

const container = taskDefinitions[0].containerDefinitions[0];
assert.strictEqual(container.image, inputs.images.worker, 'expected the released image');
assert.strictEqual(
  taskDefinitions[0].cpu,
  '1024',
  'expected the spec CPU on the task definition',
);
assert.strictEqual(container.environment !== undefined, true, 'expected environment entries');

const containerEnv = {};
for (const pair of container.environment) containerEnv[pair.name] = pair.value;
assert.strictEqual(
  containerEnv.BEDROCK_KNOWLEDGE_BASE_HANDBOOK !== undefined,
  true,
  'expected the knowledge base id in the container environment',
);
assert.strictEqual(
  container.secrets[0].valueFrom,
  inputs.secretArns.OPENAI_API_KEY,
  'expected the secret resolved from its ARN',
);

assert.strictEqual(listenerRules.length, 2, 'expected one rule per declared path');
assert.deepStrictEqual(
  listenerRules.map((rule) => rule.priority).sort((a, b) => a - b),
  [1, 2],
  'expected sorted priorities',
);
assert.deepStrictEqual(
  listenerRules.map(
    (rule) => rule.conditions[0].pathPatternConfig.values[0],
  ).sort(),
  ['/chat', '/chat/*'],
  'expected the declared paths',
);
