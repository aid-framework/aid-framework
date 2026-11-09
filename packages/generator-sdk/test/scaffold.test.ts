// biome-ignore-all lint/suspicious/noTemplateCurlyInString: assertions read the emitted shell and Actions expressions literally.
/**
 * The scaffold tier: a file the generator creates once and then hands over.
 *
 * Three properties make the tier safe, and each one is a test here:
 *
 * 1. **It is never overwritten.** A developer edits a workflow; a later `gen` must not
 *    undo that edit, and there is no drift conflict to resolve because there is no hash.
 * 2. **It is never in the manifest.** The manifest claims exactly what the generator
 *    owns; a scaffold record with a hash would turn every legitimate edit into drift.
 * 3. **It is never ejected.** `eject` moves ownership of a *generated* file; a scaffold
 *    file is already the caller's, so ejecting it is a no-op rather than a move.
 */

import { describe, expect, it } from 'vitest';

import {
  type AidManifestProvenance,
  ambientCredentialNote,
  CI_WORKFLOW_PATH,
  type CiProfile,
  createMemorySink,
  EVALS_WORKFLOW_PATH,
  type EvalProfile,
  eject,
  formatRegenerationSummary,
  type GeneratedFile,
  INFRA_PLAN_WORKFLOW_PATH,
  isScaffoldPath,
  ownerForPath,
  type Plan,
  planRegeneration,
  RELEASE_WORKFLOW_PATH,
  type ReleaseProfile,
  regenerate,
  scaffoldCi,
  scaffoldEvals,
  scaffoldInfraPlan,
  scaffoldRelease,
  TOFU_VERSION,
} from '../src/index.js';

const PROVENANCE: AidManifestProvenance = {
  generator: '@aid-framework/generator-py-fastapi',
  generatorVersion: '0.1.0',
  irVersion: '0.1.0',
};

const PROFILE: CiProfile = {
  target: 'py-fastapi',
  specPath: 'app/app.spec.yaml',
  dependencyManifest: 'pyproject.toml',
  toolchain: ['- uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065'],
  install: ['pip install -e ".[dev]"'],
  lint: ['ruff check .'],
  build: 'python -m compileall -q app',
  test: 'pytest -q',
};

function generated(path: string, content = 'x = 1\n'): GeneratedFile {
  return { path, content, owner: 'generated' };
}

const MAIN = 'app/generated/main.py';

describe('the scaffold tier', () => {
  it('owns a workflow file by its path, and nothing above the workflow directory', () => {
    expect(isScaffoldPath('.github/workflows/ci.yml')).toBe(true);
    expect(ownerForPath('.github/workflows/ci.yml')).toBe('scaffold');
    // A directory is not a file: the tier owns files under the prefix, not the prefix.
    expect(isScaffoldPath('.github/workflows/')).toBe(false);
    expect(isScaffoldPath('.github/CODEOWNERS')).toBe(false);
    expect(ownerForPath('.github/CODEOWNERS')).toBeUndefined();
  });

  it('does not let the scaffold tier shadow the two managed tiers', () => {
    const roots = { generatedDir: 'app/generated', businessDir: 'app/business' };
    expect(ownerForPath('app/generated/main.py', roots)).toBe('generated');
    expect(ownerForPath('app/business/handlers.py', roots)).toBe('business');
    expect(ownerForPath('.github/workflows/ci.yml', roots)).toBe('scaffold');
  });
});

describe('scaffoldCi', () => {
  const file = scaffoldCi(PROFILE, '0.1');

  it('emits the workflow at the path the scaffold tier owns', () => {
    expect(file.path).toBe(CI_WORKFLOW_PATH);
    expect(file.owner).toBe('scaffold');
    expect(ownerForPath(file.path)).toBe('scaffold');
  });

  it('gates the tree on the spec, so a commit cannot diverge from it', () => {
    expect(file.content).toContain(`aid gen ${PROFILE.specPath} --check`);
    expect(file.content).toContain(`aid validate ${PROFILE.specPath}`);
    // The CLI is pinned to the release line, never `latest`.
    expect(file.content).toContain('@aid-framework/cli@0.1');
  });

  it('never plans an apply, so a pull request cannot reach a cloud account', () => {
    expect(file.content).not.toContain('infra plan --apply');
    expect(file.content).not.toContain('apply');
    expect(file.content).toContain('contents: read');
  });

  it('pins every action to a full commit SHA rather than a moving tag', () => {
    const uses = file.content
      .split('\n')
      .filter((line) => line.includes('uses:'))
      .map((line) => line.slice(line.indexOf('uses:') + 'uses:'.length).trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      expect(reference, reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });

  it('skips the app job rather than reporting it green without a dependency manifest', () => {
    expect(file.content).toContain(`if [ -f ${PROFILE.dependencyManifest} ]`);
    expect(file.content).toContain("if: needs.detect.outputs.has_app == 'true'");
  });
});

describe('scaffoldEvals', () => {
  const EVAL_PROFILE: EvalProfile = {
    ...PROFILE,
    suites: [
      { id: 'classify_quality', command: 'python -m app.generated.evals.classify_quality' },
      { id: 'handbook_quality', command: 'python -m app.generated.evals.handbook_quality' },
    ],
    secrets: ['OPENAI_API_KEY'],
  };

  const file = scaffoldEvals(EVAL_PROFILE, '0.1');

  it('emits the workflow at the path the scaffold tier owns', () => {
    expect(file.path).toBe(EVALS_WORKFLOW_PATH);
    expect(file.owner).toBe('scaffold');
  });

  it('runs on demand and nightly, never on a pull request', () => {
    expect(file.content).toContain('workflow_dispatch:');
    expect(file.content).toContain('schedule:');
    expect(file.content).not.toContain('pull_request');
  });

  it('asks for no write permission, because the gate only reads', () => {
    expect(file.content).toContain('permissions:\n  contents: read');
  });

  it('pins every action to a full commit SHA rather than a moving tag', () => {
    const uses = file.content
      .split('\n')
      .filter((line) => line.includes('uses:'))
      .map((line) => line.slice(line.indexOf('uses:') + 'uses:'.length).trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      expect(reference, reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });

  it('fails loudly when the model credential is absent rather than skipping the gate', () => {
    expect(file.content).toContain('id: creds');
    expect(file.content).toContain("if: steps.creds.outputs.ready != 'true'");
    expect(file.content).toContain('::error::');
    expect(file.content).toContain('exit 1');
  });

  it('runs one step per declared suite, gated on the credential probe', () => {
    for (const suite of EVAL_PROFILE.suites) {
      expect(file.content).toContain(`run: ${suite.command}`);
    }
    const gated = file.content
      .split('\n')
      .filter((line) => line.includes("if: steps.creds.outputs.ready == 'true'"));
    expect(gated).toHaveLength(EVAL_PROFILE.suites.length + 1);
  });

  it('captures the spans the eval run produces, so spend can be read afterwards', () => {
    expect(file.content).toContain('AID_TRACE_DIR: .aid-traces');
    expect(file.content).toContain('aid cost .aid-traces');
    // The CLI has to be on the runner for the cost step; it is pinned to the release line.
    expect(file.content).toContain('@aid-framework/cli@0.1');
  });

  it('takes the spending ceiling from a repository variable, never an invented default', () => {
    expect(file.content).toContain('BUDGET: ${{ vars.AID_COST_BUDGET }}');
    expect(file.content).toContain('aid cost .aid-traces --budget "$BUDGET"');
    // Unset means report-only, so a project that spends more is not failed by a guess.
    expect(file.content).toContain('aid cost .aid-traces\n');
  });

  it('omits the credential guard when every model is a fake', () => {
    const fakeOnly = scaffoldEvals({ ...EVAL_PROFILE, secrets: [] }, '0.1');
    expect(fakeOnly.content).not.toContain('id: creds');
    expect(fakeOnly.content).not.toContain('::error::');
    for (const suite of EVAL_PROFILE.suites) {
      expect(fakeOnly.content).toContain(`run: ${suite.command}`);
    }
    // Trace capture and the cost step do not depend on a credential.
    expect(fakeOnly.content).toContain('AID_TRACE_DIR: .aid-traces');
    expect(fakeOnly.content).toContain('aid cost .aid-traces');
  });

  it('names the ambient credential a keyless provider needs, without gating on it', () => {
    const note = 'Bedrock reads its credential from the AWS SDK chain.';
    const keyless = scaffoldEvals({ ...EVAL_PROFILE, secrets: [], credentialNote: note }, '0.1');
    expect(keyless.content).toContain(`::notice::${note}`);
    // Nothing can probe the SDK chain portably, so the gate runs and the provider's own
    // error is left to fail it; a synthetic probe would report a false negative.
    expect(keyless.content).not.toContain('id: creds');
    expect(keyless.content).not.toContain('::error::');
    expect(keyless.content).not.toContain("if: steps.creds.outputs.ready == 'true'");
  });

  it('ignores the note when a secret can be checked instead', () => {
    const keyed = scaffoldEvals({ ...EVAL_PROFILE, credentialNote: 'unused' }, '0.1');
    expect(keyed.content).not.toContain('::notice::unused');
    expect(keyed.content).toContain('id: creds');
  });
});

describe('ambientCredentialNote', () => {
  it('names the cloud each keyless provider authenticates against', () => {
    expect(ambientCredentialNote(['bedrock'])).toContain('AWS SDK chain');
    expect(ambientCredentialNote(['google'])).toContain('Application Default Credentials');
    expect(ambientCredentialNote(['bedrock', 'google'])).toContain('AWS SDK chain');
    expect(ambientCredentialNote(['bedrock', 'google'])).toContain(
      'Application Default Credentials',
    );
  });

  it('says nothing for a provider whose credential the spec already names', () => {
    expect(ambientCredentialNote(['openai', 'fake'])).toBeUndefined();
    expect(ambientCredentialNote([])).toBeUndefined();
  });
});

describe('scaffoldInfraPlan', () => {
  const file = scaffoldInfraPlan({ target: 'py-fastapi' }, '0.1');

  it('emits the workflow at the path the scaffold tier owns', () => {
    expect(file.path).toBe(INFRA_PLAN_WORKFLOW_PATH);
    expect(file.owner).toBe('scaffold');
  });

  it('is dispatch-only, because a fork pull request cannot assume a cloud role', () => {
    expect(file.content).toContain('workflow_dispatch:');
    expect(file.content).not.toContain('pull_request');
    expect(file.content).not.toContain('schedule:');
  });

  it('asks for an OIDC token and no write permission, so the role is the only credential', () => {
    expect(file.content).toContain('permissions:\n  contents: read\n  id-token: write');
    expect(file.content).toContain('aws-actions/configure-aws-credentials@');
    expect(file.content).toContain('role-to-assume:');
    // A stored key would be a secret to rotate; the whole point of OIDC is that there is
    // nothing in the repository to leak.
    expect(file.content).not.toContain('secrets.');
    expect(file.content).not.toContain('aws-access-key-id');
  });

  it('pins every action to a full commit SHA and the toolchain to one release', () => {
    const uses = file.content
      .split('\n')
      .filter((line) => line.includes('uses:'))
      .map((line) => line.slice(line.indexOf('uses:') + 'uses:'.length).trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      expect(reference, reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
    expect(file.content).toContain(`tofu_version: '${TOFU_VERSION}'`);
  });

  it('reports nothing to plan rather than failing when no infrastructure was generated', () => {
    expect(file.content).toContain('-f infra/generated/deploy.auto.tfvars.json');
    expect(file.content).toContain('-f infra/generated/deploy.cdk-context.json');
    expect(file.content).toContain('::notice::');
    // Unlike the eval gate, infra is optional: a project without `infra/` has no plan to
    // be missing, so the absent branch must not be an error.
    const detectStep = file.content.slice(
      0,
      file.content.indexOf('      - name: Check the cloud credential'),
    );
    expect(detectStep).toContain('::notice::');
    expect(detectStep).not.toContain('exit 1');
  });

  it('fails when the infrastructure exists but the credential does not', () => {
    expect(file.content).toContain('id: creds');
    expect(file.content).toContain('AID_INFRA_ROLE_ARN');
    expect(file.content).toContain('AID_INFRA_REGION');
    expect(file.content).toContain('::error::');
    expect(file.content).toContain('exit 1');
  });

  it('initialises the environment root before planning, because aid infra does not', () => {
    const init = file.content.indexOf('init -input=false');
    const plan = file.content.indexOf('aid infra plan');
    expect(init).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(init);
    expect(file.content).toContain('tofu -chdir="infra/envs/$ENV" init');
  });

  it('drives both backends from one dispatch input', () => {
    expect(file.content).toContain("if: steps.creds.outputs.ready == 'true' && env.IAC == 'tofu'");
    expect(file.content).toContain("if: steps.creds.outputs.ready == 'true' && env.IAC == 'cdk'");
    expect(file.content).toContain('aws-cdk@2');
    expect(file.content).toContain('aid infra plan --env "$ENV" --iac "$IAC"');
    expect(file.content).toContain('options:\n          - tofu\n          - cdk');
  });

  it('installs the pinned CLI, so the plan runs the released command', () => {
    expect(file.content).toContain('@aid-framework/cli@0.1');
  });
});

describe('scaffoldRelease', () => {
  const RELEASE_PROFILE: ReleaseProfile = {
    target: 'py-fastapi',
    specPath: 'app/app.spec.yaml',
    dockerfile: 'app/generated/Dockerfile',
    images: [
      { registry: 'ghcr.io', name: 'acme/support-copilot', deploymentIds: ['api'] },
      { registry: 'ghcr.io', name: 'acme/handbook-worker', deploymentIds: ['worker'] },
    ],
  };

  const file = scaffoldRelease(RELEASE_PROFILE, '0.1');

  it('emits the workflow at the path the scaffold tier owns', () => {
    expect(file.path).toBe(RELEASE_WORKFLOW_PATH);
    expect(file.owner).toBe('scaffold');
    expect(ownerForPath(file.path)).toBe('scaffold');
  });

  it('is triggered by a tag, so only a release publishes an image', () => {
    expect(file.content).toContain('    tags: [v*]');
    expect(file.content).not.toContain('branches:');
    // A cancelled run can leave one tag pushed and the other not.
    expect(file.content).toContain('  cancel-in-progress: false');
  });

  it('asks for the one token scope a package push needs, and no stored password', () => {
    expect(file.content).toContain('  contents: read');
    expect(file.content).toContain('  packages: write');
    expect(file.content).not.toContain('contents: write');
    // The run's own token authenticates the push, so no registry secret is referenced.
    expect(file.content).not.toContain('secrets.');
  });

  it('checks the tagged tree against the spec before an image is built from it', () => {
    expect(file.content).toContain(`aid validate ${RELEASE_PROFILE.specPath}`);
    expect(file.content).toContain(`aid gen ${RELEASE_PROFILE.specPath} --check`);
    expect(file.content).toContain('@aid-framework/cli@0.1');
    expect(file.content).toContain('    needs: guard');
  });

  it('publishes each image as its own matrix entry, so one failure cannot hide another', () => {
    expect(file.content).toContain('      fail-fast: false');
    for (const image of RELEASE_PROFILE.images) {
      expect(file.content).toContain(`          - registry: ${image.registry}`);
      expect(file.content).toContain(`            image: ${image.name}`);
    }
    // The matrix names the deployments an entry came from, so a reader can trace it back.
    expect(file.content).toContain('          # deployments.api');
    expect(file.content).toContain('          # deployments.worker');
  });

  it('builds the Dockerfile from the repository root, tagging the release and the commit', () => {
    expect(file.content).toContain(`-f ${RELEASE_PROFILE.dockerfile}`);
    expect(file.content).toContain('sha="sha-${GITHUB_SHA::7}"');
    expect(file.content).toContain('docker push "${REGISTRY}/${IMAGE}:${tag}"');
    expect(file.content).toContain('docker push "${REGISTRY}/${IMAGE}:${sha}"');
  });

  it('publishes an image and stops there, because a release is not a deployment', () => {
    expect(file.content).not.toContain('infra plan --apply');
    expect(file.content).not.toContain('aws-access-key-id');
    expect(file.content).not.toContain('kubectl');
    expect(file.content).toContain('# applies infrastructure or restarts a service.');
  });

  it('pins every action to a full commit SHA rather than a moving tag', () => {
    const uses = file.content
      .split('\n')
      .filter((line) => line.includes('uses:'))
      .map((line) => line.slice(line.indexOf('uses:') + 'uses:'.length).trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      expect(reference, reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
  });

  it('swaps the token login for the secret pair a registry declares', () => {
    const docker = scaffoldRelease(
      {
        ...RELEASE_PROFILE,
        images: [
          {
            registry: 'docker.io',
            name: 'acme/support-copilot',
            deploymentIds: ['api'],
            usernameSecret: 'DOCKERHUB_USERNAME',
            tokenSecret: 'DOCKERHUB_TOKEN',
          },
        ],
      },
      '0.1',
    );

    expect(docker.content).toContain('      - name: Log in to docker.io');
    expect(docker.content).toContain(
      '          REGISTRY_USERNAME: ${{ secrets.DOCKERHUB_USERNAME }}',
    );
    expect(docker.content).toContain('          REGISTRY_TOKEN: ${{ secrets.DOCKERHUB_TOKEN }}');
    expect(docker.content).toContain('--username "$REGISTRY_USERNAME"');
    // Nothing reads the workflow token, so the push scope is not requested.
    expect(docker.content).not.toContain('GITHUB_ACTOR');
    expect(docker.content).not.toContain('packages: write');
  });

  it('refuses to emit a login it has no secret names for', () => {
    // The spec gate reports this first; reaching the scaffold means a hand-built
    // profile, and `secrets.undefined` would fail on the first tag instead of here.
    expect(() =>
      scaffoldRelease(
        {
          ...RELEASE_PROFILE,
          images: [{ registry: 'docker.io', name: 'acme/p', deploymentIds: ['api'] }],
        },
        '0.1',
      ),
    ).toThrow(/needs `usernameSecret` and `tokenSecret`/);
  });
});

describe('regenerating over the scaffold tier', () => {
  const plan: Plan = { files: [generated(MAIN), scaffoldCi(PROFILE, '0.1')] };

  it('creates the workflow once, when the project has none', () => {
    const sink = createMemorySink();
    const report = planRegeneration(plan, { sink });

    expect(report.created).toEqual([CI_WORKFLOW_PATH, MAIN].sort());
    expect(report.scaffoldKept).toEqual([]);
  });

  it('keeps the workflow, byte for byte, when the developer has edited it', () => {
    const edited = `${scaffoldCi(PROFILE, '0.1').content}\n# our own runner cache\n`;
    const sink = createMemorySink({ [CI_WORKFLOW_PATH]: edited, [MAIN]: 'x = 1\n' });
    const { report, manifest } = regenerate(plan, {
      sink,
      manifest: undefined,
      provenance: PROVENANCE,
    });

    expect(report.created).toEqual([]);
    expect(report.scaffoldKept).toEqual([CI_WORKFLOW_PATH]);
    expect(sink.files.get(CI_WORKFLOW_PATH)).toBe(edited);
    // A generated file with no manifest record is still drift, so the edit is not
    // hiding a broken tree.
    expect(report.drifted.map((entry) => entry.path)).toEqual([MAIN]);
    expect(manifest.files.some((entry) => entry.path === CI_WORKFLOW_PATH)).toBe(false);
  });

  it('does not record the workflow in the manifest on a clean first run', () => {
    const sink = createMemorySink();
    const { manifest } = regenerate(plan, { sink, manifest: undefined, provenance: PROVENANCE });

    expect(manifest.files.map((entry) => entry.path).sort()).toEqual([MAIN]);
  });

  it('reports the kept scaffold count in the summary only when there is one', () => {
    const quiet = planRegeneration({ files: [generated(MAIN)] }, { sink: createMemorySink() });
    expect(formatRegenerationSummary(quiet)).not.toContain('scaffold');

    const kept = planRegeneration(plan, {
      sink: createMemorySink({ [CI_WORKFLOW_PATH]: 'name: ours\n', [MAIN]: 'x = 1\n' }),
    });
    expect(formatRegenerationSummary(kept)).toContain('1 scaffold kept');
  });

  it("does not eject a workflow, because it is already the caller's", () => {
    const sink = createMemorySink({ [CI_WORKFLOW_PATH]: 'name: ours\n' });
    const result = eject({ path: CI_WORKFLOW_PATH, sink, manifest: undefined });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('already-owned');
    // `from` names the path, matching the business no-op; nothing was moved, so there is
    // no destination to report.
    expect(result.from).toBe(CI_WORKFLOW_PATH);
    expect(sink.files.has(CI_WORKFLOW_PATH)).toBe(true);
  });
});
