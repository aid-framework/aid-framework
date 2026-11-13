---
description: "A spec that names the enterprise tier and omits its controls, refused four times by named diagnostics, then fixed."
---

# Walkthrough: the enterprise profile

`profile: enterprise` is not a label. It is a claim the spec must back with controls that AID can
actually generate, and the `profile` gate refuses a document that names the tier and skips them.

This walkthrough takes one working spec, adds two lines to it, and collects four refusals before
reaching a spec that passes. Every console block below is real output.

## Run it

```bash
mkdir enterprise && cd enterprise
cp ../../examples/guarded-reply/app/app.spec.yaml .
```

Edit the copy so its header reads:

```yaml
specVersion: "0.25"
profile: enterprise
```

Then:

```bash
aid validate enterprise.spec.yaml
```

## What enterprise demands today

The profile is enforced per deployment and once per document.

| Requirement | Diagnostic | Scope |
| --- | --- | --- |
| A pinned region | [`ir/profile-region`](#refusal-1-the-missing-controls) | Every deployment |
| A pinned audit sink | [`ir/profile-audit`](#refusal-1-the-missing-controls) | Every deployment |
| At least one guardrail inspecting model output | [`ir/profile-guardrail`](#refusal-3-no-output-guardrail) | The document |

And the three placement checks that apply to **every** profile, enterprise or not:

| Requirement | Diagnostic |
| --- | --- |
| The cloud must be one AID provisions -- [Azure and Kubernetes are deferred by decision](../reference/support.md) | `ir/cloud-unsupported` |
| The region must be one the pinned cloud offers | `ir/region-target` |
| The audit sink must be one the pinned cloud can create | `ir/audit-target` |
| Deployments must agree on one cloud and one audit destination | `ir/cloud-conflict`, `ir/audit-conflict` |

## What 0.26 adds to `enterprise`

A 0.26 document must now also name the identity it authenticates against, a private network, and a
production approval policy — and its agents that can write need somewhere durable to wait.

| Requirement | Diagnostic | Scope |
| --- | --- | --- |
| A declared `identity` | `ir/profile-identity` | Every deployment |
| A `network` with `private: true` | `ir/profile-network` | Every deployment |
| An `approvals` policy for production | `ir/profile-approvals` | A deployment that targets production |
| A `state` store for an agent that can call a writing tool | `ir/agents-state-store` | Every such agent |

These four are scoped to `specVersion: "0.26"`, because 0.25 has no key to satisfy them with;
holding an old document to a rule it cannot express would make it unsatisfiable.

**What is gated is not yet generated.** `state`, `identity`, `network`, `approvals` and
`requiresApproval` are validated, projected into the IR, and refused when wrong — and the
generators that emit the store, the identity check and the pause land in their own release. That
is stated on the `/features` row and in [`docs/migration.md`](../migration.md) rather than left for
an operator to discover by reading generated code. AID still does not refuse a spec for omitting
something it cannot generate, and it does not claim a capability it has not written.

## Refusal 1: the missing controls

```console
$ aid validate enterprise.spec.yaml
enterprise.spec.yaml: 2 error(s), 1 warning(s)
enterprise.spec.yaml: warning: the eval-coverage gate flagged this pipeline: "answer_message" is served over HTTP but no eval with gate.ci: true targets it [ir/eval-uncovered]
    at pipelines.answer_message
    hint: add an eval targeting "pipeline:answer_message" and set gate.ci: true
enterprise.spec.yaml: error: the profile gate rejected "api": the enterprise profile requires every deployment to pin an audit sink [ir/profile-audit]
    at deployments.api
    hint: add `audit: { sink: cloudwatch }` (or the sink your cloud provides) so the record has a destination
enterprise.spec.yaml: error: the profile gate rejected "api": the enterprise profile requires every deployment to pin the region its data must stay in [ir/profile-region]
    at deployments.api
    hint: add `region: <region>` (and `cloud:` if the deployment does not pin one)
```

Both errors name the same deployment, and both are per deployment rather than per document: two
deployments under `enterprise` need two regions pinned, not one between them.

The warning is unrelated to the profile and was already there - `guarded-reply` has never declared a
CI eval. It is shown here because a real run shows it, and because it is the kind of thing that gets
mistaken for a profile failure.

## Refusal 2: the controls must fit the cloud

The obvious next move is to satisfy both errors at once, badly:

```yaml
deployments:
  api:
    target: container
    cloud: gcp
    region: eu-central-1
    audit:
      sink: cloudwatch
    secrets: [OPENAI_API_KEY]
```

```console
$ aid validate enterprise.spec.yaml
enterprise.spec.yaml: 2 error(s), 1 warning(s)
enterprise.spec.yaml: error: the profile gate rejected "api": audit sink "cloudwatch" is not one gcp can create [ir/audit-target]
    at deployments.api.audit.sink
    hint: gcp sinks: gcs, bigquery
enterprise.spec.yaml: error: the profile gate rejected "api": region "eu-central-1" is not a gcp region [ir/region-target]
    at deployments.api.region
    hint: pin a region gcp offers, such as africa-south1 or asia-east1
```

`eu-central-1` is a real region. It is an **AWS** region, and the deployment says GCP. `cloudwatch` is
a real audit sink. It is an AWS sink. A spec that pinned either one under `cloud: aws` would be
accepted; under `cloud: gcp` both are refused, and the hint names the values that would work rather
than leaving you to look them up.

This is the whole reason the region and the sink are spec keys and not module inputs. A region that
reaches a module unchecked is a `plan` that fails forty seconds into `tofu` with a provider error
about an unknown zone; here it is a diagnostic with a fix, before anything is generated.

## Refusal 3: no output guardrail

Fixing the cloud values resolves both. Drop the `output`-stage guardrail and a third refusal appears -
one the first spec never triggered, because `guarded-reply` declares `reply_pii` at `output`:

```console
$ aid validate enterprise.spec.yaml
enterprise.spec.yaml: 1 error(s), 1 warning(s)
enterprise.spec.yaml: error: the profile gate rejected the document: the enterprise profile requires at least one guardrail that inspects model output [ir/profile-guardrail]
    at guardrails
    hint: add a guardrail with `stages: [output]`; an input-only guardrail cannot see what the model says
```

Note the path: `guardrails`, not `deployments`. The requirement is on the document, because a guardrail
is declared once and applied by whichever route or step names it. An input guardrail inspects what the
caller sent. What the enterprise tier is being asked for here is a control on what the model says back.

Restore the guardrail and the spec passes:

```console
$ aid validate enterprise.spec.yaml
enterprise.spec.yaml: ok (0 errors, 1 warnings)
```

## What the passing spec generates

`aid gen` records the placement, so a reader of the generated tree can see which tier produced it and
where it was told to run:

```python
"placements": [
    {
        "audit": {"retentionDays": 400, "sink": "gcs"},
        "cloud": "gcp",
        "id": "api",
        "region": "europe-west1",
    },
],
"profile": "enterprise",
```

`aid infra gen` turns the audit sink into a module rather than a comment:

```console
$ aid infra gen enterprise.spec.yaml --cloud gcp
infra/generated: 12 created, 0 updated, 0 unchanged, 0 kept
  created  infra/generated/README.md
  created  infra/generated/deploy.auto.tfvars.json
  created  infra/generated/deploy.cdk-context.json
  created  infra/generated/deploy.plan.json
  created  infra/generated/modules/audit/main.tf
  created  infra/generated/modules/audit/outputs.tf
  created  infra/generated/modules/audit/variables.tf
  created  infra/generated/modules/audit/versions.tf
  created  infra/generated/modules/cloudrun/main.tf
  created  infra/generated/modules/cloudrun/outputs.tf
  created  infra/generated/modules/cloudrun/variables.tf
  created  infra/generated/modules/cloudrun/versions.tf
```

The module is emitted only when the plan pinned a destination, and its README row says which:

| Path | Provided when | What it is |
| --- | --- | --- |
| `modules/audit/` | `deployment.audit` is set | The audit destination a `deployment.audit` sink pins: a log sink into a GCS archive bucket or a BigQuery dataset. |

`retentionDays` is honoured by all four sinks. For a bucket it sets the lifecycle expiry; for BigQuery
it sets the dataset's default partition expiration; for CloudWatch the log group's
`retention_in_days`, where `0` means never expire.

With `--iac cdk` the same pin produces `cdk/audit.cjs` instead, so the destination does not depend on
which backend you picked.

## The flag and the pin cannot disagree

Once the spec pins a cloud, `--cloud` is redundant and a contradiction is refused:

```console
$ aid infra gen enterprise.spec.yaml --cloud aws
<spec>: error: The spec pins cloud "gcp", but --cloud names "aws". [cli/infra-cloud-conflict]
    hint: Drop --cloud to deploy the cloud the spec pins, or change the spec's `cloud:` to "aws" if the pin is stale.
```

This is a different diagnostic from `ir/cloud-conflict`, which fires when two *deployments* in one
document name different clouds. Same disagreement, different source, so the code says which one you
have to edit.

## A spec with no `profile`

Absent means `standard`, and nothing about it changes. The `profile` gate's placement checks still run -
a region that the cloud does not offer is refused whether or not a tier was named - but no control is
required and no artifact moves. Regenerating an existing 0.24 spec at 0.25 produces byte-identical
output; see [Migrating](../migration.md).

Read next: [delivery controls](delivery-controls.md) for the 0.26 controls this walkthrough's tier
now also requires, [guarded-reply](guarded-reply.md) for the example this one starts from, or
[the spec reference](../reference/spec.md#top-level-keys) for `profile` and the `audit` block.
