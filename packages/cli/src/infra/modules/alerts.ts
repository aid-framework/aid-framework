/**
 * Provider code: the alarm policies the document declared.
 *
 * One resource per declared alert, with every value written literally. The thresholds are
 * known at generation time, so the generated tree is a faithful record of what was asked
 * for: a reviewer reads the diff and sees the number, and CI's `tofu validate` proves the
 * exact text the README prints. Nothing here is computed at apply time.
 *
 * ## The series these alarms watch
 *
 * Every metric name is one of the four the deploy plan derives -- `agent.cost`,
 * `agent.tokens`, `eval.cost`, `eval.latency.p95` -- published into one namespace this
 * module also exports. The names are not invented here: `ALERT_METRICS` is asserted equal
 * to `DeployAlarm['metric']`, so an alarm cannot watch a series nothing produces.
 *
 * ## What it deliberately does not do
 *
 * - **Run the collector.** The runtime exports spans over OTLP; something has to turn
 *   those spans into a metric series before an alarm can watch one, and that something is
 *   an OpenTelemetry Collector the operator runs. AID exports `metric_namespace` for
 *   exactly this reason: the collector's metric exporter is configured against it, and
 *   the two cannot silently disagree. Generating a collector deployment is not built, and
 *   the CLI reference says so.
 * - **Page anyone.** An alarm with no action notifies no one, and a notification channel
 *   is an operator's account detail -- the same reason `audit_bucket_name` is an input.
 *   `alert_channel_ids` carries it, and an empty list creates the alarm without a
 *   destination rather than failing an apply to guess one.
 * - **Treat silence as health.** Missing data leaves the alarm in `INSUFFICIENT_DATA`
 *   rather than resolving to OK. A pipeline that stopped exporting is not a pipeline that
 *   came in under budget, and this module does not let an alarm say it did.
 */

import type { AlertAggregate, AlertWindow, DeployAlert, DeployPlan } from '@aid-framework/ir';

import { type Cloud, DEFAULT_CLOUD } from '../cloud.js';
import { INFRA_GENERATED_DIR } from '../paths.js';
import { hcl, type ModuleFile, moduleFiles } from './hcl.js';

export const ALERTS_MODULE_DIR = `${INFRA_GENERATED_DIR}/modules/alerts`;

/**
 * Every window the schema offers, in seconds.
 *
 * A CloudWatch `period` and a GCP alignment period are the same quantity spelled two
 * ways, so the conversion lives in one table. CloudWatch caps a standard-resolution period
 * at the largest window here, which is why the schema stops at `24h`.
 */
const WINDOW_SECONDS: Record<AlertWindow, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
};

/**
 * The CloudWatch statistic that applies the declared reduction. Percentiles are not
 * `statistic` values on CloudWatch: the provider rejects anything outside its closed
 * enum, so a percentile goes in `extended_statistic` instead.
 */
const AWS_STATISTICS: Partial<Record<AlertAggregate, string>> = {
  sum: 'Sum',
  average: 'Average',
  max: 'Maximum',
};

/** CloudWatch spells percentiles as `pNN`, and only in the extended-statistics argument. */
const AWS_EXTENDED_STATISTICS: Partial<Record<AlertAggregate, string>> = {
  p95: 'p95',
};

/** The GCP aligner that applies the declared reduction across time. */
const GCP_ALIGNERS: Record<AlertAggregate, string> = {
  sum: 'ALIGN_SUM',
  average: 'ALIGN_MEAN',
  max: 'ALIGN_MAX',
  p95: 'ALIGN_PERCENTILE_95',
};

/** The GCP reducer that applies the declared reduction across series. */
const GCP_REDUCERS: Record<AlertAggregate, string> = {
  sum: 'REDUCE_SUM',
  average: 'REDUCE_MEAN',
  max: 'REDUCE_MAX',
  // A mean of per-series p95 values is the only reducer that reads as a fleet percentile;
  // summing percentiles would describe a total that has no meaning.
  p95: 'REDUCE_MEAN',
};

/**
 * A valid HCL identifier for an alert id.
 *
 * The schema already restricts an id to `[a-z][a-z0-9_]*`, so this changes nothing for a
 * document that passed validation. It exists because a caller can build an IR directly,
 * and an id that is fine in JSON can still be an invalid block label.
 */
function blockName(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** The sentence a human reads in the console when the alarm fires. */
function description(alert: DeployAlert): string {
  const scope =
    alert.source === undefined ? 'across the whole environment' : `for "${alert.source}"`;
  return `${alert.metric} (${alert.aggregate}) over ${alert.window} exceeded ${alert.threshold} ${alert.unit} ${scope}. Declared in observability.alerts.`;
}

/**
 * A free-text value as the body of an HCL quoted attribute.
 *
 * The backslash is escaped *before* the quote, not after. Escaping only the quote leaves a
 * trailing backslash in the input able to escape the generated attribute's closing quote,
 * which unbalances the file the provider then has to parse.
 */
function hclString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const AWS_VERSIONS_TF = hcl([
  '# Generated by `aid infra gen`. Do not edit: the next run refuses to overwrite a',
  '# hand-edited file, and the module carries no project-specific fact to keep.',
  'terraform {',
  '  required_version = ">= 1.6.0"',
  '',
  '  required_providers {',
  '    aws = {',
  '      source  = "hashicorp/aws"',
  '      version = "~> 6.18"',
  '    }',
  '  }',
  '}',
]);

const AWS_VARIABLES_TF = hcl([
  'variable "project" {',
  '  type = object({',
  '    name      = string',
  '    namespace = string',
  '  })',
  '}',
  '',
  'variable "alert_channel_ids" {',
  '  description = "ARNs of the CloudWatch actions the alarms notify. Empty creates the alarms without a destination."',
  '  type        = list(string)',
  '  default     = []',
  '}',
  '',
  'variable "tags" {',
  '  type    = map(string)',
  '  default = {}',
  '}',
]);

const AWS_OUTPUTS_TF = hcl([
  'output "metric_namespace" {',
  '  description = "The CloudWatch namespace every alarm here watches. Configure the collector\'s metric exporter to publish into it."',
  '  value       = local.metric_namespace',
  '}',
  '',
  'output "alarm_arns" {',
  '  description = "The alarms this module created, one per declared alert."',
  '  value       = local.alarm_arns',
  '}',
]);

const GCP_VERSIONS_TF = hcl([
  '# Generated by `aid infra gen`. Do not edit: the next run refuses to overwrite a',
  '# hand-edited file, and the module carries no project-specific fact to keep.',
  'terraform {',
  '  required_version = ">= 1.6.0"',
  '',
  '  required_providers {',
  '    google = {',
  '      source  = "hashicorp/google"',
  '      # The same floor the knowledge-base, model-armor and audit modules set: one env',
  '      # root has one version per provider.',
  '      version = "~> 8.4"',
  '    }',
  '  }',
  '}',
]);

const GCP_VARIABLES_TF = hcl([
  'variable "project" {',
  '  type = object({',
  '    name      = string',
  '    namespace = string',
  '  })',
  '}',
  '',
  'variable "project_id" {',
  '  description = "The project the alert policies are created in."',
  '  type        = string',
  '}',
  '',
  'variable "alert_channel_ids" {',
  '  description = "Ids of the notification channels the policies notify. Empty creates the policies without a destination."',
  '  type        = list(string)',
  '  default     = []',
  '}',
  '',
  'variable "tags" {',
  '  type    = map(string)',
  '  default = {}',
  '}',
]);

const GCP_OUTPUTS_TF = hcl([
  'output "metric_prefix" {',
  '  description = "The custom metric prefix every policy here watches. Configure the collector\'s metric exporter to publish under it."',
  '  value       = local.metric_prefix',
  '}',
  '',
  'output "alarm_ids" {',
  '  description = "The alert policies this module created, one per declared alert."',
  '  value       = local.alarm_ids',
  '}',
]);

/**
 * The `local` block every AWS alarm reads.
 *
 * The namespace carries the project's own name so two projects in one account do not
 * share a series, and it is exported so the collector config can be pointed at it rather
 * than at a copy of the spelling.
 */
function awsLocals(alerts: DeployAlert[]): string {
  const arns = alerts.map((alert) => `aws_cloudwatch_metric_alarm.${blockName(alert.id)}.arn`);
  return hcl([
    'locals {',
    '  metric_namespace = "AID/@{var.project.namespace}/@{var.project.name}"',
    '',
    '  alarm_arns = [',
    ...arns.map((arn) => `    ${arn},`),
    '  ]',
    '}',
  ]);
}

function awsAlarm(alert: DeployAlert): string {
  const lines = [
    `resource "aws_cloudwatch_metric_alarm" "${blockName(alert.id)}" {`,
    `  alarm_name        = "aid-@{var.project.namespace}-@{var.project.name}-${alert.id}"`,
    `  alarm_description = "${hclString(description(alert))}"`,
    '',
    '  namespace   = local.metric_namespace',
    `  metric_name = "${alert.metric}"`,
  ];
  if (alert.source !== undefined) {
    lines.push('', '  dimensions = {', `    Source = "${hclString(alert.source)}"`, '  }');
  }
  const statistic = AWS_STATISTICS[alert.aggregate];
  const extended = AWS_EXTENDED_STATISTICS[alert.aggregate];
  lines.push('', `  period              = ${WINDOW_SECONDS[alert.window]}`);
  if (statistic !== undefined) {
    lines.push(`  statistic           = "${statistic}"`);
  }
  if (extended !== undefined) {
    lines.push(`  extended_statistic  = "${extended}"`);
  }
  lines.push(
    '  comparison_operator = "GreaterThanThreshold"',
    `  threshold           = ${alert.threshold}`,
    '',
    '  # One period is one evaluation: the window in the document *is* the period, so a',
    '  # second evaluation would watch a longer span than the author declared.',
    '  evaluation_periods  = 1',
    '  datapoints_to_alarm = 1',
    '',
    '  # A pipeline that stopped exporting is not a pipeline that came in under budget.',
    '  treat_missing_data = "missing"',
    '',
    '  alarm_actions = var.alert_channel_ids',
    '',
    '  tags = var.tags',
    '}',
  );
  return hcl(lines);
}

function gcpAlarm(alert: DeployAlert): string {
  // Only a declared source narrows the policy to one series; without one the reducer
  // spans every series in the namespace, which is what "the whole environment" means.
  const label =
    alert.source === undefined ? '' : ` AND metric.label.source=\\"${hclString(alert.source)}\\"`;
  return hcl([
    `resource "google_monitoring_alert_policy" "${blockName(alert.id)}" {`,
    '  project      = var.project_id',
    `  display_name = "aid-@{var.project.name}-${alert.id}"`,
    '  combiner     = "OR"',
    '',
    '  conditions {',
    `    display_name = "${hclString(description(alert))}"`,
    '',
    '    condition_threshold {',
    `      filter          = "metric.type=\\"@{local.metric_prefix}${alert.metric}\\" AND resource.type=\\"global\\"${label}"`,
    '      comparison      = "COMPARISON_GT"',
    `      threshold_value = ${alert.threshold}`,
    '',
    '      # The window in the document is the alignment period, so the policy measures',
    '      # what the author declared rather than a provider default.',
    '      duration = "0s"',
    '',
    '      aggregations {',
    `        alignment_period     = "${WINDOW_SECONDS[alert.window]}s"`,
    `        per_series_aligner   = "${GCP_ALIGNERS[alert.aggregate]}"`,
    `        cross_series_reducer = "${GCP_REDUCERS[alert.aggregate]}"`,
    '      }',
    '    }',
    '  }',
    '',
    '  notification_channels = var.alert_channel_ids',
    '',
    '  user_labels = var.tags',
    '}',
  ]);
}

function gcpLocals(alerts: DeployAlert[]): string {
  const ids = alerts.map((alert) => `google_monitoring_alert_policy.${blockName(alert.id)}.id`);
  return hcl([
    'locals {',
    '  metric_prefix = "custom.googleapis.com/aid/"',
    '',
    '  alarm_ids = [',
    ...ids.map((id) => `    ${id},`),
    '  ]',
    '}',
  ]);
}

/**
 * The module, or nothing.
 *
 * Nothing is emitted when the document declares no alert, which keeps every project that
 * declared none byte-identical to the tree it generated before `observability.alerts`
 * existed -- including the README, which embeds the env root this module is called from.
 */
export function emitAlertsModule(plan: DeployPlan, cloud: Cloud = DEFAULT_CLOUD): ModuleFile[] {
  if (plan.alerts.length === 0) return [];
  const render = cloud === 'gcp' ? gcpAlarm : awsAlarm;
  const locals = cloud === 'gcp' ? gcpLocals : awsLocals;
  return moduleFiles(ALERTS_MODULE_DIR, {
    versions: cloud === 'gcp' ? GCP_VERSIONS_TF : AWS_VERSIONS_TF,
    variables: cloud === 'gcp' ? GCP_VARIABLES_TF : AWS_VARIABLES_TF,
    main: hcl([locals(plan.alerts), '', ...plan.alerts.map(render)]),
    outputs: cloud === 'gcp' ? GCP_OUTPUTS_TF : AWS_OUTPUTS_TF,
  });
}
