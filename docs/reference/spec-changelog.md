---
description: "What each spec language version adds, from the original surface through the current version."
---

# Spec version changelog

A spec declares its language version with `specVersion`. The current version is `0.25`, and each row below lists what that version adds.

| Version | What it adds |
| --- | --- |
| `0.25` | Adds the top-level `profile` -- a named bundle of required controls, `standard` by default -- and `deployments[].cloud`, `.region` and `.audit`, which put the placement and the audit record in the spec instead of in whoever's shell ran the apply. |
| `0.24` | Adds `gateways` and `deployments[].runtime.gateway`, which federate tools behind a managed Amazon Bedrock AgentCore Gateway endpoint a runtime reaches over MCP instead of bundling them. |
| `0.23` | Implements `retrievers[].refresh.schedule`, the UTC five-field cron the compiler turns into a scheduler (`aws_scheduler_schedule` or `google_cloud_scheduler_job`) that submits the batch job running that retriever's ingest. |
| `0.22` | Implements `chunking.strategy: semantic`, which cuts a document where adjacent-unit embedding similarity dips rather than at a fixed size. |
| `0.21` | Adds the `s3` and `http` retriever sources, which load a corpus from an object store or a single URL; `db` and `mcp` remain reserved. |
| `0.20` | Lets a retriever declare `filters`, the field/operator/value expressions that narrow a query to the passages a tenant or classification allows; a filter is never copied into the generated code as data, so a filter narrows candidates rather than replacing a policy check. |
| `0.19` | Lets a retriever declare `refresh.mode: incremental`, which embeds only chunks the index does not already hold and deletes the vectors of documents the corpus no longer contains. |
| `0.18` | Adds `gcp.artifact-registry`, which federates through Workload Identity and prefixes the repository path with the project. |
| `0.17` | Adds `aws.ecr`, which derives its host from the account and region and assumes an IAM role through GitHub's OIDC provider. |
| `0.16` | Lets `deployments[].image` name a registry other than `ghcr.io` by naming the repository secrets its login reads, rather than holding a credential value in the spec. |
| `0.15` | Adds the `modelArmor` policy block, which lets the spec own the Model Armor template instead of naming one the operator already created. |
| `0.14` | Adds `engine: model-armor`, which hands a guardrail's policy to Vertex AI Model Armor, the Google Cloud counterpart to a managed Bedrock guardrail. |
| `0.13` | Adds `deployments[].runtime`, which moves a `container` service onto a managed agent runtime (Amazon Bedrock AgentCore or the Gemini Enterprise Agent Platform) instead of a compute module AID keeps warm. |
| `0.12` | Adds `knowledgeBases` and `retrievers[].knowledgeBase`, which bind a retriever to a managed knowledge base (Bedrock Knowledge Bases or Vertex AI RAG) instead of a local source, chunker, embedder and store. |
| `0.11` | Adds `guardrails[].engine` and the `bedrock` policy block, which move a guardrail's policy into a managed AWS Bedrock guardrail. |
| `0.10` | Adds the `gemini` provider, which calls the Gemini API with an API key instead of Google Cloud credentials. |
| `0.9` | Adds the `route` pipeline step, which runs the arm a `choice` decision's answer names. |
| `0.8` | Adds the `decision` metric kind, which scores an eval prediction with a `score` decision. |
| `0.7` | Lets a `guardrails` entry name a decision (`decision` + `onDecision`). |
| `0.6` | Adds the `google` provider (Vertex AI) and the `decisions` section (TypeSafe AI Jev). |
| `0.5` | Adds `pipelines[].trigger.manual` and `deployments[].pipeline`, the pair that lets a `target: batch` deployment run one pipeline once to completion. |
| `0.4` | Adds `deployments[].image`, the registry and repository a container image is published to. |
| `0.3` | Adds the `models[].cache` construct (prompt and semantic caching). |
| `0.2` | Adds the closed `agents`, `guardrails`, `memory` and `deployments` sections. |
| `0.1` | The original surface. |

A section or construct that needs a later version is reported as `spec/not-supported` with the version it needs, rather than as an unknown key.
