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

assert.strictEqual(functions.length, 1, 'expected one Lambda function');
assert.strictEqual(routes.length, 1, 'expected one HTTP API route');
assert.strictEqual(routes[0].routeKey, 'GET /ping', 'expected the spec route key');
