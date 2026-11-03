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

const { addServerless } = require('../../generated/cdk/serverless.cjs');

const here = path.join(__dirname, '..');
const context = JSON.parse(fs.readFileSync(path.join(here, 'context.json'), 'utf8'));
const inputs = JSON.parse(fs.readFileSync(path.join(here, 'inputs.json'), 'utf8'));

const app = new cdk.App();
const stack = new cdk.Stack(app, 'AidFixture', {
  env: { account: '111111111111', region: 'us-east-1' },
});

addServerless(stack, context, inputs);

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
