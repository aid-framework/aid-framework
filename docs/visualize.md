---
description: "Draw a spec YAML in the browser, or serve the same picture locally with aid visualize: three readings of one declaration, and the gate diagnostics that refuse an impossible one."
layout: page
sidebar: false
---

<div class="visualize-page vp-doc" role="main">

# See what the spec declares

A spec is short enough to read and too dense to hold in your head: models calling tools, tools
reaching retrieval, guardrails on four different stages, deployments crossing clouds. This page
draws it. Paste a spec, or load one of the examples below, and the diagram is built in your browser.

Nothing is uploaded. The page runs the same validator and the same gates the CLI runs, so what it
shows you is what `aid gen` would accept, and when it refuses, it refuses with the identical
diagnostic codes and the identical hints.

<AidVisualizer />

## Three readings of one declaration

The picture is drawn top to bottom in three bands, because those are the three questions worth
asking about a spec, and they have different shapes.

**Architecture** is the system as it runs. The trigger that starts a request, the identity and
gateway in front of it, one box per deployment, the data those deployments reach, and every
outbound call. This band is about distributed-systems facts: what is a separate process, what
crosses a network boundary, what is called over egress.

**Process** is each pipeline as a lane, its steps left to right in the order they run. Guardrail
invocations, prompt renderings, retrieval, tool calls, and model calls appear at the position they
occupy in the request, which is the part a manifest cannot tell you.

**Inventory** is what the process is built from, in a fixed group order, so the same spec always
lays out the same way and two specs can be compared by eye.

## Selecting a box

Select a component and the canvas recedes to its edges: everything the selection touches stays lit
and the rest dims. The inspector names what it is and where it is declared. Selecting a step also
opens the request flow it belongs to, so a guardrail in the middle of a pipeline can be read in the
context it is invoked from.

The legend lists the edge kinds. Click one to hide that kind, which is the fastest way to answer
"what does this agent actually call" without reading five hundred lines of YAML.

## When the picture is a refusal

A spec that cannot be generated does not get a partial picture. It gets the refusals:

```text
app/app.spec.yaml: error: the agents gate rejected "triage_agent": it may take up to 10 steps but
declares neither maxTokensBudget nor maxCostBudget, so nothing bounds what one run costs
[ir/agents-budget]
    at agents.triage_agent.maxTokensBudget
    hint: declare maxTokensBudget or maxCostBudget, or set maxSteps: 1
```

This is deliberate, and it is the reason the page compiles rather than parses. A visualiser that
drew whatever it could find would produce a convincing diagram of a service that will not build,
and the diagram would be the more persuasive of the two artifacts. Here, the refusal is the
finding.

## The same picture, served locally

The served version watches the file and redraws as you edit it, which is what you want while
writing a spec rather than reviewing one.

```sh
npx @aid-framework/cli visualize
npx @aid-framework/cli visualize app/app.spec.yaml --port 4321
npx @aid-framework/cli visualize app/app.spec.yaml --json
```

`--json` prints the graph and its layout instead of serving them, so a CI job can assert that a
spec still draws what it drew.

## What the picture does not tell you

It draws the declaration, not a deployment: it cannot tell you whether the OIDC issuer resolves,
whether the private network is actually peered, or whether the reviewers named in an approval policy
exist. Those are declared and gated for presence, never verified.

It also draws one spec. For a customer's effective configuration, draw the resolved spec that
`aid resolve` writes, because that is the artifact the build compiles.

</div>
