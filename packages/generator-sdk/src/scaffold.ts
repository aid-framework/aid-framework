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

import { imageRegistry, type RegistryAuthKind } from '@aid-framework/spec';
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
  googleAuth: 'google-github-actions/auth@71f986410dfbc7added4569d411d040a91dc6935',
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
  /**
   * What a project with no secret name must supply instead, for a real model whose
   * credential comes from the environment: Bedrock's AWS chain, Vertex's Application
   * Default Credentials. No step can probe that chain portably, so the workflow states the
   * requirement in a notice rather than claiming a run is ready. Ignored when `secrets` is
   * non-empty, and absent for a fake-only project, which needs nothing.
   */
  readonly credentialNote?: string;
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
 * What a model provider without a secret name needs in place of one.
 *
 * Bedrock and Vertex read credentials from the SDK chain rather than a variable the
 * gateway reads, so `declaredSecrets` finds no name to check. A provider absent from this
 * table gets no note: silence is honest, an invented requirement is not.
 */
export function ambientCredentialNote(providers: readonly string[]): string | undefined {
  const notes = new Set<string>();
  for (const provider of providers) {
    if (provider === 'bedrock') {
      notes.add(
        'Bedrock reads its credential from the AWS SDK chain: configure an OIDC role or ' +
          'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for this repository.',
      );
    }
    if (provider === 'google') {
      notes.add(
        'Vertex reads Application Default Credentials: configure Workload Identity ' +
          'Federation or GOOGLE_APPLICATION_CREDENTIALS for this run.',
      );
    }
  }
  return notes.size === 0 ? undefined : [...notes].sort().join(' ');
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

  /**
   * A keyless provider has no variable to probe, but the run still needs a credential.
   * The notice keeps the reason in the log next to the provider's own error, which
   * otherwise reads as an unexplained authentication failure.
   */
  const noteSteps =
    !guarded && profile.credentialNote !== undefined
      ? [
          '      - name: Note the credential this run needs',
          `        run: echo "::notice::${profile.credentialNote}"`,
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
    ...noteSteps,
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
  /**
   * The host `docker login` and `docker push` address, when it is not the registry id. An
   * ECR host carries the account and the region, which the workflow derives rather than
   * asking the spec to restate.
   */
  readonly loginServer?: string;
  /**
   * The values the login step reads from this matrix entry, when the credential is
   * per-account: a region and a role for ECR, a region and a Workload Identity pair for
   * Artifact Registry.
   */
  readonly loginFields?: Readonly<Record<string, string>>;
  /** The repository secret naming the account, for a `secret-pair` registry. */
  readonly usernameSecret?: string;
  /** The repository secret holding the access token, for a `secret-pair` registry. */
  readonly tokenSecret?: string;
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
 * whatever the spec declared, and the login follows that registry's credential path: the
 * `GITHUB_TOKEN` the run already holds (which is why a `ghcr.io` release asks for
 * `packages: write`), or the repository secrets the image names, never a password stored
 * in the repository. There is no `apply` step: publishing an image is not deploying it.
 *
 * The build is the one the Dockerfile's own header documents, so the workflow and the
 * file agree by construction: the context is the repository root and the file is named
 * with `-f`. Each image is a matrix entry, so a project publishing two cannot have one
 * failure hide the other; a spec that names the same repository twice is one entry, not
 * two racing pushes.
 */
export function scaffoldRelease(profile: ReleaseProfile, cliRange: string): GeneratedFile {
  // A cloud registry's host is derived from the account, so the matrix carries it and the
  // job reads it back. A profile whose hosts are all registry ids keeps the two-line entry
  // it always had, which is why this is conditional rather than always emitted.
  const derivedHosts = profile.images.some((image) => image.loginServer !== undefined);
  const matrix = profile.images.flatMap((image) => [
    `          # ${image.deploymentIds.map((id) => `deployments.${id}`).join(', ')}`,
    `          - registry: ${image.registry}`,
    `            image: ${image.name}`,
    ...(derivedHosts ? [`            login: ${image.loginServer ?? image.registry}`] : []),
    ...Object.entries(image.loginFields ?? {}).map(
      ([field, value]) => `            ${field}: ${value}`,
    ),
  ]);

  const logins = releaseLogins(profile.images);
  // One login step is the common case and stays unguarded, which also keeps a
  // `ghcr.io`-only release byte-for-byte what it was before a second registry existed.
  const loginSteps = logins.flatMap((login) =>
    loginStep(login, logins.length === 1 ? undefined : matrixCondition(login)),
  );
  const tokenOnly = logins.every((login) => login.authKind === 'github-token');
  const credentialLines = tokenOnly
    ? [
        '# `deployments[].image`, and the credential is the token GitHub already issues, so',
        '# there is no registry password to store. Publishing is not deploying: nothing here',
        '# applies infrastructure or restarts a service.',
      ]
    : [
        '# `deployments[].image`, and each login uses the token this run already has, the',
        '# repository secrets it names, or an OIDC identity exchanged for a short-lived cloud',
        '# credential, so no credential value is stored here. Publishing is not deploying:',
        '# nothing here applies infrastructure or restarts a service.',
      ];

  const content = [
    `# Generated once by \`aid gen\` for the \`${profile.target}\` target, then yours.`,
    '# A scaffold file is never overwritten and never recorded in aid.manifest.json.',
    '# A tag push publishes the image the spec names. The registry is the one declared in',
    ...credentialLines,
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
    // `packages: write` is the GITHUB_TOKEN scope; a declared secret pair needs no scope.
    ...(logins.some((login) => login.authKind === 'github-token') ? ['  packages: write'] : []),
    // A federated cloud login exchanges the run's OIDC token, which needs its own scope.
    ...(logins.some((login) => login.authKind === 'aws-oidc' || login.authKind === 'gcp-wif')
      ? ['  id-token: write']
      : []),
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
    // The login, the build and the push all address `REGISTRY`. For a registry whose host
    // is derived it is the matrix's `login`, so the image reference is the real one.
    ...(derivedHosts
      ? [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
          '      REGISTRY: ${{ matrix.login }}',
        ]
      : [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
          '      REGISTRY: ${{ matrix.registry }}',
        ]),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
    '      IMAGE: ${{ matrix.image }}',
    '    steps:',
    `      - uses: ${ACTION_PINS.checkout}`,
    // Only a mixed profile needs the guard; a single login applies to every entry.
    ...(logins.length === 1
      ? []
      : ['      # One login per credential path; the condition selects the entry it serves.']),
    ...loginSteps,
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

/** One login, shared by every image entry that resolves to the same credential. */
interface ReleaseLogin {
  readonly authKind: RegistryAuthKind;
  readonly registry: string;
  readonly usernameSecret?: string;
  readonly tokenSecret?: string;
  readonly images: readonly ReleaseImage[];
}

/**
 * Groups the matrix entries by the credential they need.
 *
 * Two images pushed under one Docker Hub account declare the same two secret names and
 * share a step; two accounts do not, and each gets its own guarded step. The grouping is
 * by the literal secret names, so the emitted `secrets.<NAME>` references are static. A
 * cloud login is grouped the same way over the declared identity fields, because two ECR
 * accounts are two roles even though they are one registry.
 */
function releaseLogins(images: readonly ReleaseImage[]): ReleaseLogin[] {
  const byKey = new Map<
    string,
    {
      authKind: RegistryAuthKind;
      registry: string;
      usernameSecret?: string;
      tokenSecret?: string;
      images: ReleaseImage[];
    }
  >();
  for (const image of images) {
    const descriptor = imageRegistry(image.registry);
    const authKind: RegistryAuthKind = descriptor?.authKind ?? 'github-token';
    const usernameSecret = authKind === 'secret-pair' ? image.usernameSecret : undefined;
    const tokenSecret = authKind === 'secret-pair' ? image.tokenSecret : undefined;
    if (authKind === 'secret-pair' && (usernameSecret === undefined || tokenSecret === undefined)) {
      // The spec gate refuses this before a generator runs; reaching it means a profile
      // was assembled by hand, and `secrets.undefined` would fail on the first tag rather
      // than here.
      throw new Error(
        `release image ${image.registry}/${image.name} needs \`usernameSecret\` and \`tokenSecret\`; ${image.registry} authenticates with a secret pair`,
      );
    }
    const loginFieldNames = descriptor?.loginFields;
    const missing = (loginFieldNames ?? []).filter(
      (field) => image.loginFields?.[field] === undefined,
    );
    if (missing.length > 0) {
      // Same reason: a federated login with no role or provider emits `matrix.undefined`,
      // which fails on the first tag instead of here.
      throw new Error(
        `release image ${image.registry}/${image.name} needs ${missing.map((field) => `\`${field}\``).join(', ')}; ${image.registry} authenticates per account`,
      );
    }
    const key = [
      image.registry,
      authKind,
      usernameSecret ?? '',
      tokenSecret ?? '',
      JSON.stringify(image.loginFields ?? {}),
    ].join('\u0000');
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        authKind,
        registry: image.registry,
        ...(usernameSecret === undefined ? {} : { usernameSecret }),
        ...(tokenSecret === undefined ? {} : { tokenSecret }),
        images: [image],
      });
    } else {
      existing.images.push(image);
    }
  }
  return [...byKey.values()];
}

/** The `if:` that selects the matrix entries a guarded login serves. */
function matrixCondition(login: ReleaseLogin): string {
  // Selected by the entry's own values, not by registry: two accounts on the same registry
  // are two variants, and a registry-only guard would run both logins for both.
  return login.images
    .map((image) => {
      const clauses = [`matrix.registry == '${image.registry}'`, `matrix.image == '${image.name}'`];
      if (image.loginServer !== undefined) {
        clauses.push(`matrix.login == '${image.loginServer}'`);
      }
      return clauses.join(' && ');
    })
    .join(' || ');
}

/** The login step for one credential path, unguarded when it is the only one. */
function loginStep(login: ReleaseLogin, condition: string | undefined): string[] {
  const guard = condition === undefined ? [] : [`        if: ${condition}`];
  if (login.authKind === 'github-token') {
    return [
      '      - name: Log in to the registry',
      ...guard,
      '        env:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
      '          REGISTRY_TOKEN: ${{ github.token }}',
      '        # The password reaches docker on stdin, so it is not part of the process list.',
      '        run: echo "$REGISTRY_TOKEN" | docker login "$REGISTRY" --username "$GITHUB_ACTOR" --password-stdin',
    ];
  }
  if (login.authKind === 'aws-oidc') {
    return [
      '      - name: Assume the publish role',
      ...guard,
      `        uses: ${ACTION_PINS.configureAws}`,
      '        with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
      '          role-to-assume: ${{ matrix.roleArn }}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
      '          aws-region: ${{ matrix.region }}',
      `      - name: Log in to ${login.registry}`,
      '        # The action above exports AWS_REGION; the password reaches docker on stdin.',
      '        run: aws ecr get-login-password --region "$AWS_REGION" | docker login "$REGISTRY" --username AWS --password-stdin',
    ];
  }
  if (login.authKind === 'gcp-wif') {
    return [
      '      - name: Authenticate to Google Cloud',
      ...guard,
      `        uses: ${ACTION_PINS.googleAuth}`,
      '        with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
      '          workload_identity_provider: ${{ matrix.workloadIdentityProvider }}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, emitted literally.
      '          service_account: ${{ matrix.serviceAccount }}',
      `      - name: Log in to ${login.registry}`,
      '        # gcloud is preinstalled on the runner; the token reaches docker on stdin.',
      '        run: gcloud auth print-access-token | docker login --username oauth2accesstoken --password-stdin "$REGISTRY"',
    ];
  }
  return [
    `      - name: Log in to ${login.registry}`,
    ...guard,
    '        env:',
    `          REGISTRY_USERNAME: \${{ secrets.${login.usernameSecret} }}`,
    `          REGISTRY_TOKEN: \${{ secrets.${login.tokenSecret} }}`,
    '        # The password reaches docker on stdin, so it is not part of the process list.',
    '        run: echo "$REGISTRY_TOKEN" | docker login "$REGISTRY" --username "$REGISTRY_USERNAME" --password-stdin',
  ];
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
