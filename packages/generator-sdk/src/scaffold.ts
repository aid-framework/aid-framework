/**
 * Scaffold content: generator-authored files that live outside the managed roots (§6a).
 *
 * Today that is the repository's own CI. It is planned like any other file, but it is
 * written once and then belongs to the developer: `aid gen` never overwrites it, never
 * records it in the manifest, and `aid eject` reports it as already owned. That split is
 * what makes a generated workflow usable -- CI has to be edited for a runner, a
 * credential, or a second toolchain, and every one of those edits would otherwise be a
 * drift conflict against a file the developer is supposed to own.
 *
 * The emitted workflow deliberately contains **no** `apply` step and no cloud keys: it
 * gates the repository and stops there. Deployment stays a human action, per §12.6.
 */

import type { GeneratedFile } from './plan.js';

/** The repository CI: the spec gates, then lint/build/test for the app tier. */
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

/**
 * The eval gate. A separate workflow because it needs a model credential and therefore
 * cannot be a required check on a fork pull request: it runs on `workflow_dispatch` and
 * nightly, and reports a skip -- not a pass -- when the credential is absent.
 */
export const EVALS_WORKFLOW_PATH = '.github/workflows/evals.yml';

/**
 * The infrastructure plan. Manual, because it assumes a cloud role: a fork pull request
 * cannot hold that identity, and a plan against a real account is something a human
 * dispatches after reviewing what changed.
 */
export const INFRA_PLAN_WORKFLOW_PATH = '.github/workflows/infra-plan.yml';

/**
 * Action pins. A tag is mutable; a SHA is not, and a generated workflow that runs
 * `@v4` is one force-push away from running different code than it did last week.
 * These are the commits the `v4`/`v5` tags resolved to when this was written.
 */
export const ACTION_PINS = {
  checkout: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  setupNode: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  setupPython: 'actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065',
  configureAws: 'aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd',
  setupTofu: 'opentofu/setup-opentofu@a1320f892987e89d278cc92dc5adc984fb93aca4',
} as const;

/**
 * The OpenTofu release the plan workflow installs. Pinned like the actions are: a floating
 * `latest` would let a plan change shape because the runner downloaded a new release.
 */
export const TOFU_VERSION = '1.13.2';

export interface CiProfile {
  /** The target name, used in the workflow's title so a reader knows what generated it. */
  readonly target: string;
  /** Spec path relative to the repository root. */
  readonly specPath: string;
  /**
   * The file that proves the app tier has dependencies to install.
   * When it is absent the build job is *skipped*, not green: the repository has a spec
   * but no application yet, and a check that passes because it never ran is the failure
   * mode §6a exists to prevent.
   */
  readonly dependencyManifest: string;
  /** Steps that put the language toolchain on the runner, as prepared YAML lines. */
  readonly toolchain: readonly string[];
  /** Shell lines that install the app's dependencies. */
  readonly install: readonly string[];
  /** Shell lines for lint/format. */
  readonly lint: readonly string[];
  /** Shell line for the type check or build. */
  readonly build: string;
  /** Shell line for the unit tests. */
  readonly test: string;
}

/** One generated eval module and the command that runs it from the project root. */
export interface EvalSuite {
  readonly id: string;
  readonly command: string;
}

export interface EvalProfile {
  /** The target name, used in the workflow's title so a reader knows what generated it. */
  readonly target: string;
  /** Spec path relative to the repository root. */
  readonly specPath: string;
  /** Steps that put the language toolchain on the runner, as prepared YAML lines. */
  readonly toolchain: readonly string[];
  /** Shell lines that install the app's dependencies. */
  readonly install: readonly string[];
  /**
   * Shell lines that make the app runnable, for a target whose evals execute compiled
   * output rather than source. Python's evals import source modules, so it passes none.
   */
  readonly prepare?: readonly string[];
  /** The CI-gated evals, in declaration order. Never empty when a workflow is emitted. */
  readonly suites: readonly EvalSuite[];
  /**
   * Environment variables the generated gateway reads a model key from. When this is
   * empty every model is a fake, so the gate runs unguarded. When it is not, the gate is
   * skipped with a warning unless every one of them is set: a real model behind a gate
   * cannot be measured without its credential.
   */
  readonly secrets: readonly string[];
}

/** `major.minor` of a semver string, used to pin the CLI a workflow installs. */
export function cliRangeFor(version: string): string {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  return match === null ? version : `${match[1]}.${match[2]}`;
}

function lines(values: readonly string[], indent = '          '): string[] {
  return values.map((value) => `${indent}${value}`);
}

/**
 * The CI workflow for a generated project.
 *
 * The spec gates are the framework's own contract and always run. The app job needs the
 * project's dependency manifest, and a job-level `if` cannot call `hashFiles`, so a small
 * `detect` job probes for the file and the app job is skipped -- not green -- without it.
 * The infra job is skipped the same way when `infra/` is absent, and it only compares the
 * committed tree against the spec: `plan`/`apply` need credentials and stay human actions.
 */
export function scaffoldCi(profile: CiProfile, cliRange: string): GeneratedFile {
  const content = [
    `# Generated once by \`aid gen\` for the \`${profile.target}\` target, then yours.`,
    '# A scaffold file is never overwritten and never recorded in aid.manifest.json,',
    '# so edit it freely: a new runner, a cache, an extra toolchain.',
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'concurrency:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '  group: ci-${{ github.workflow }}-${{ github.ref }}',
    '  cancel-in-progress: true',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  spec:',
    '    name: Spec gates',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    `      - uses: ${ACTION_PINS.setupNode}`,
    '        with:',
    "          node-version: '22'",
    '      - name: Install the AID CLI',
    `        run: npm install --global @aid-framework/cli@${cliRange}`,
    '      - name: Validate the spec',
    `        run: aid validate ${profile.specPath}`,
    '      - name: The committed tree matches the spec',
    `        run: aid gen ${profile.specPath} --check`,
    '      - name: Diagnose the tree',
    `        run: aid doctor ${profile.specPath}`,
    '',
    '  detect:',
    '    name: Detect the app',
    '    runs-on: ubuntu-latest',
    '    outputs:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '      has_app: ${{ steps.probe.outputs.has_app }}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '      has_infra: ${{ steps.infra.outputs.has_infra }}',
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    '      - id: probe',
    '        run: |',
    `          if [ -f ${profile.dependencyManifest} ]; then`,
    '            echo "has_app=true" >> "$GITHUB_OUTPUT"',
    '          else',
    '            echo "has_app=false" >> "$GITHUB_OUTPUT"',
    '          fi',
    '      - id: infra',
    '        run: |',
    '          if [ -d infra ]; then',
    '            echo "has_infra=true" >> "$GITHUB_OUTPUT"',
    '          else',
    '            echo "has_infra=false" >> "$GITHUB_OUTPUT"',
    '          fi',
    '',
    '  app:',
    '    name: Lint, build, and test',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 20',
    '    needs: detect',
    `    # Skipped, not green: without ${profile.dependencyManifest} there is nothing to`,
    `    # build, and a passing check that never ran is worse than an explicit skip.`,
    `    if: needs.detect.outputs.has_app == 'true'`,
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    ...lines(profile.toolchain, '      '),
    '      - name: Install dependencies',
    '        run: |',
    ...lines(profile.install, '          '),
    '      - name: Lint',
    '        run: |',
    ...lines(profile.lint, '          '),
    '      - name: Build',
    `        run: ${profile.build}`,
    '      - name: Test',
    `        run: ${profile.test}`,
    '',
    '  infra:',
    '    name: Infra matches the spec',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    '    needs: detect',
    '    # Skipped, not green: a project that has not generated infra/ has no committed',
    '    # tree to compare, and this job never plans against a cloud account.',
    `    if: needs.detect.outputs.has_infra == 'true'`,
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    `      - uses: ${ACTION_PINS.setupNode}`,
    '        with:',
    "          node-version: '22'",
    '      - name: Install the AID CLI',
    `        run: npm install --global @aid-framework/cli@${cliRange}`,
    '      - name: The committed infra tree matches the spec',
    `        run: aid infra gen ${profile.specPath} --check`,
    '',
  ].join('\n');

  return { path: CI_WORKFLOW_PATH, content, owner: 'scaffold' };
}

/**
 * The eval gate for a project whose spec declares `gate.ci: true` evals.
 *
 * It never runs on `pull_request`. The generated evals measure a real model: with no
 * credential the gateway falls back to the fake provider, whose output does not satisfy
 * the eval's JSON schema, and the gate fails. Requiring the key on PRs would therefore
 * either leak a secret to forks or turn the gate red for every contributor, so the gate
 * runs on `workflow_dispatch` and nightly instead, and a missing key is an **error**
 * rather than a silent skip: a gate that is green because it never ran is the failure
 * mode this whole tier exists to avoid.
 *
 * The eval steps name `AID_TRACE_DIR`, which is how the same run also measures spend:
 * the runtime writes one JSONL span per model call when that variable is set, and the
 * last step hands the directory to `aid cost`. The ceiling is the repository variable
 * `AID_COST_BUDGET` rather than a number the generator invents -- a budget is a project
 * decision, and an emitted default would silently fail a project that legitimately
 * spends more. Unset means the step reports and does not fail.
 */
export function scaffoldEvals(profile: EvalProfile, cliRange: string): GeneratedFile {
  const guarded = profile.secrets.length > 0;

  /** Every eval step writes spans here; the cost step then reads the same directory. */
  const traceDir = '.aid-traces';

  const credentialSteps = guarded
    ? [
        '      - name: Check the model credential',
        '        id: creds',
        '        env:',
        ...profile.secrets.map((name) => `          ${name}: \${{ secrets.${name} }}`),
        '        run: |',
        '          missing=0',
        ...profile.secrets.flatMap((name) => [
          `          if [ -z "$${name}" ]; then`,
          `            echo "::warning::${name} is not set"`,
          '            missing=1',
          '          fi',
        ]),
        '          if [ "$missing" -eq 0 ]; then',
        '            echo "ready=true" >> "$GITHUB_OUTPUT"',
        '          else',
        '            echo "ready=false" >> "$GITHUB_OUTPUT"',
        '          fi',
      ]
    : [];

  const suiteSteps = profile.suites.flatMap((suite) => [
    `      - name: ${suite.id}`,
    ...(guarded ? ["        if: steps.creds.outputs.ready == 'true'"] : []),
    '        env:',
    `          AID_TRACE_DIR: ${traceDir}`,
    ...(guarded ? profile.secrets.map((name) => `          ${name}: \${{ secrets.${name} }}`) : []),
    `        run: ${suite.command}`,
  ]);

  const skippedSteps = guarded
    ? [
        '      - name: Report a skipped gate',
        "        if: steps.creds.outputs.ready != 'true'",
        '        run: |',
        `          echo "::error::The eval gate could not run: set ${profile.secrets.join(', ')} as ${profile.secrets.length === 1 ? 'a repository secret' : 'repository secrets'}."`,
        '          exit 1',
      ]
    : [];

  const content = [
    `# Generated once by \`aid gen\` for the \`${profile.target}\` target, then yours.`,
    '# A scaffold file is never overwritten and never recorded in aid.manifest.json.',
    '# Evals measure a real model, so this workflow needs the model credential; it runs',
    '# on demand and nightly rather than on pull requests, which cannot hold a secret.',
    'name: Evals',
    '',
    'on:',
    '  workflow_dispatch:',
    '  schedule:',
    "    - cron: '0 6 * * *'",
    '',
    'concurrency:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '  group: evals-${{ github.workflow }}-${{ github.ref }}',
    '  cancel-in-progress: false',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  evals:',
    '    name: Eval gate',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    `      - uses: ${ACTION_PINS.setupNode}`,
    '        with:',
    "          node-version: '22'",
    '      - name: Install the AID CLI',
    `        run: npm install --global @aid-framework/cli@${cliRange}`,
    ...lines(profile.toolchain, '      '),
    '      - name: Install dependencies',
    '        run: |',
    ...lines(profile.install, '          '),
    ...(profile.prepare === undefined
      ? []
      : ['      - name: Build the app', '        run: |', ...lines(profile.prepare, '          ')]),
    ...credentialSteps,
    ...suiteSteps,
    '      - name: Cost ceiling',
    ...(guarded ? ["        if: steps.creds.outputs.ready == 'true'"] : []),
    '        env:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '          BUDGET: ${{ vars.AID_COST_BUDGET }}',
    '        run: |',
    '          if [ -n "$BUDGET" ]; then',
    `            aid cost ${traceDir} --budget "$BUDGET"`,
    '          else',
    `            aid cost ${traceDir}`,
    '          fi',
    ...skippedSteps,
    '',
  ].join('\n');

  return { path: EVALS_WORKFLOW_PATH, content, owner: 'scaffold' };
}

/**
 * The image release. Manual in the sense that a tag is a human decision, but a tag push
 * is the trigger, because the artifact it builds is named by the deployment.
 */
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';

export interface ReleaseImage {
  /** The registry the spec declared, e.g. `ghcr.io`. */
  readonly registry: string;
  /** The repository path inside the registry, e.g. `acme/support-copilot`. */
  readonly name: string;
  /** The deployments that declared it, in code-unit order, for the reader. */
  readonly deploymentIds: readonly string[];
}

export interface ReleaseProfile {
  /** The target name, used in the workflow's title so a reader knows what generated it. */
  readonly target: string;
  /** Spec path relative to the repository root. */
  readonly specPath: string;
  /** The Dockerfile, relative to the repository root; the build context is the root. */
  readonly dockerfile: string;
  /** At least one image: the workflow is not emitted otherwise. */
  readonly images: readonly ReleaseImage[];
}

/**
 * The release workflow, for a project whose spec names a registry for an image.
 *
 * A tag push publishes, because an image tag is a release artifact: two commits cannot
 * push the same tag without one of them being the one a consumer pulls. The registry is
 * whatever the spec declared, and the credential is the `GITHUB_TOKEN` the run already
 * holds -- writing packages with it is why the workflow asks for `packages: write` and
 * nothing else. No long-lived registry password is stored, and there is no `apply` step:
 * publishing an image is not deploying it.
 *
 * The build is the one the Dockerfile's own header documents, so the workflow and the
 * file agree by construction: the context is the repository root and the file is named
 * with `-f`. Each image is a matrix entry, so a project publishing two cannot have one
 * failure hide the other; a spec that names the same repository twice is one entry, not
 * two racing pushes.
 */
export function scaffoldRelease(profile: ReleaseProfile, cliRange: string): GeneratedFile {
  const matrix = profile.images.flatMap((image) => [
    `          # ${image.deploymentIds.map((id) => `deployments.${id}`).join(', ')}`,
    `          - registry: ${image.registry}`,
    `            image: ${image.name}`,
  ]);

  const content = [
    `# Generated once by \`aid gen\` for the \`${profile.target}\` target, then yours.`,
    '# A scaffold file is never overwritten and never recorded in aid.manifest.json.',
    '# A tag push publishes the image the spec names. The registry is the one declared in',
    '# `deployments[].image`, and the credential is the token GitHub already issues, so',
    '# there is no registry password to store. Publishing is not deploying: nothing here',
    '# applies infrastructure or restarts a service.',
    'name: Release',
    '',
    'on:',
    '  push:',
    '    tags: [v*]',
    '',
    'concurrency:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '  group: release-${{ github.workflow }}-${{ github.ref }}',
    '  # A cancelled run can leave a tag pushed and a second one not, so a publish is never',
    '  # cancelled by a later one.',
    '  cancel-in-progress: false',
    '',
    'permissions:',
    '  contents: read',
    '  packages: write',
    '',
    'jobs:',
    '  guard:',
    '    name: Spec gates',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    `      - uses: ${ACTION_PINS.setupNode}`,
    '        with:',
    "          node-version: '22'",
    '      - name: Install the AID CLI',
    `        run: npm install --global @aid-framework/cli@${cliRange}`,
    '      - name: Validate the spec',
    `        run: aid validate ${profile.specPath}`,
    '      # A tag can point at any commit, so the tagged tree is checked against the spec',
    '      # before an image is built from it.',
    '      - name: The committed tree matches the spec',
    `        run: aid gen ${profile.specPath} --check`,
    '',
    '  publish:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '    name: Publish ${{ matrix.image }}',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 25',
    '    needs: guard',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        include:',
    ...matrix,
    '    env:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '      REGISTRY: ${{ matrix.registry }}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '      IMAGE: ${{ matrix.image }}',
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    '      - name: Log in to the registry',
    '        env:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '          REGISTRY_TOKEN: ${{ github.token }}',
    '        # The password reaches docker on stdin, so it is not part of the process list.',
    '        run: echo "$REGISTRY_TOKEN" | docker login "$REGISTRY" --username "$GITHUB_ACTOR" --password-stdin',
    '      - name: Build and publish',
    '        run: |',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, emitted literally.
    '          tag="${GITHUB_REF_NAME}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, emitted literally.
    '          sha="sha-${GITHUB_SHA::7}"',
    '          docker build \\',
    `            -f ${profile.dockerfile} \\`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, emitted literally.
    '            -t "${REGISTRY}/${IMAGE}:${tag}" \\',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, emitted literally.
    '            -t "${REGISTRY}/${IMAGE}:${sha}" .',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, emitted literally.
    '          docker push "${REGISTRY}/${IMAGE}:${tag}"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, emitted literally.
    '          docker push "${REGISTRY}/${IMAGE}:${sha}"',
    '      - name: Summarise',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, emitted literally.
    '        run: echo "Published ${REGISTRY}/${IMAGE}:${GITHUB_REF_NAME} from $GITHUB_SHA." >> "$GITHUB_STEP_SUMMARY"',
    '',
  ].join('\n');

  return { path: RELEASE_WORKFLOW_PATH, content, owner: 'scaffold' };
}

export interface InfraPlanProfile {
  /** The target name, used in the workflow's title so a reader knows what generated it. */
  readonly target: string;
}

/**
 * The infrastructure plan, for a project that has committed `infra/`.
 *
 * It is dispatch-only. A plan needs a cloud identity, and `aws-actions/configure-aws-credentials`
 * assumes it through OIDC, so no long-lived key is stored; a fork pull request cannot use
 * that identity, and a plan against a real account is a reviewed action rather than a
 * per-commit check. `ci.yml` already gates the committed tree with `aid infra gen --check`
 * on every PR, so nothing is lost by keeping the credentialed half manual.
 *
 * Two details come from how `aid infra plan` itself works: it shells out to a bare
 * `tofu plan` in the environment root, so the workflow must `init` first, and it reads
 * the generated var file, so a project that never ran `aid infra gen` has nothing to plan
 * and gets a notice instead of a red run. The tofu version is pinned rather than floating
 * so a plan does not change shape because the runner downloaded a new release.
 */
export function scaffoldInfraPlan(profile: InfraPlanProfile, cliRange: string): GeneratedFile {
  const content = [
    `# Generated once by \`aid gen\` for the \`${profile.target}\` target, then yours.`,
    '# A scaffold file is never overwritten and never recorded in aid.manifest.json.',
    '# Planning reads your cloud account, so it is a manual action rather than a pull',
    '# request check. Set AID_INFRA_ROLE_ARN and AID_INFRA_REGION as repository variables;',
    '# credentials are obtained through OIDC, so no long-lived key is stored here.',
    'name: Infra plan',
    '',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      env:',
    '        description: environment root under infra/envs, or infra/cdk/<env>',
    '        required: false',
    '        default: dev',
    '      iac:',
    '        description: backend to drive',
    '        required: false',
    '        type: choice',
    '        options:',
    '          - tofu',
    '          - cdk',
    '        default: tofu',
    '',
    'concurrency:',
    `  group: infra-plan-\${{ github.workflow }}-\${{ github.ref }}`,
    '  cancel-in-progress: false',
    '',
    'permissions:',
    '  contents: read',
    '  id-token: write',
    '',
    'jobs:',
    '  plan:',
    '    name: Plan infrastructure',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 20',
    '    env:',
    `      ENV: \${{ inputs.env }}`,
    `      IAC: \${{ inputs.iac }}`,
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    '      - name: Detect generated infrastructure',
    '        id: detect',
    '        run: |',
    '          if [ -f infra/generated/deploy.auto.tfvars.json ] || [ -f infra/generated/deploy.cdk-context.json ]; then',
    '            echo "ready=true" >> "$GITHUB_OUTPUT"',
    '          else',
    "            echo '::notice::Nothing to plan: run `aid infra gen` and commit the result.'",
    '            echo "ready=false" >> "$GITHUB_OUTPUT"',
    '          fi',
    '      - name: Check the cloud credential',
    '        id: creds',
    "        if: steps.detect.outputs.ready == 'true'",
    '        env:',
    `          ROLE: \${{ vars.AID_INFRA_ROLE_ARN }}`,
    `          REGION: \${{ vars.AID_INFRA_REGION }}`,
    '        run: |',
    '          missing=0',
    '          if [ -z "$ROLE" ]; then',
    '            echo "::warning::AID_INFRA_ROLE_ARN is not set"',
    '            missing=1',
    '          fi',
    '          if [ -z "$REGION" ]; then',
    '            echo "::warning::AID_INFRA_REGION is not set"',
    '            missing=1',
    '          fi',
    '          if [ "$missing" -eq 0 ]; then',
    '            echo "ready=true" >> "$GITHUB_OUTPUT"',
    '          else',
    '            echo "ready=false" >> "$GITHUB_OUTPUT"',
    '          fi',
    '      - name: Report a missing credential',
    "        if: steps.detect.outputs.ready == 'true' && steps.creds.outputs.ready != 'true'",
    '        run: |',
    '          echo "::error::Set AID_INFRA_ROLE_ARN and AID_INFRA_REGION as repository variables."',
    '          exit 1',
    '      - name: Configure AWS credentials',
    "        if: steps.creds.outputs.ready == 'true'",
    `        uses: ${ACTION_PINS.configureAws}`,
    '        with:',
    `          role-to-assume: \${{ vars.AID_INFRA_ROLE_ARN }}`,
    `          aws-region: \${{ vars.AID_INFRA_REGION }}`,
    `      - uses: ${ACTION_PINS.setupNode}`,
    "        if: steps.creds.outputs.ready == 'true'",
    '        with:',
    "          node-version: '22'",
    '      - name: Install the AID CLI',
    "        if: steps.creds.outputs.ready == 'true'",
    `        run: npm install --global @aid-framework/cli@${cliRange}`,
    `      - uses: ${ACTION_PINS.setupTofu}`,
    "        if: steps.creds.outputs.ready == 'true' && env.IAC == 'tofu'",
    '        with:',
    `          tofu_version: '${TOFU_VERSION}'`,
    '      - name: Initialise the environment root',
    "        if: steps.creds.outputs.ready == 'true' && env.IAC == 'tofu'",
    '        run: tofu -chdir="infra/envs/$ENV" init -input=false',
    '      - name: Install the AWS CDK',
    "        if: steps.creds.outputs.ready == 'true' && env.IAC == 'cdk'",
    '        run: npm install --global aws-cdk@2',
    '      - name: Plan',
    "        if: steps.creds.outputs.ready == 'true'",
    '        run: aid infra plan --env "$ENV" --iac "$IAC"',
    '',
  ].join('\n');

  return { path: INFRA_PLAN_WORKFLOW_PATH, content, owner: 'scaffold' };
}
