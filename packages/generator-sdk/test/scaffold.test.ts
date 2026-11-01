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
  CI_WORKFLOW_PATH,
  type CiProfile,
  createMemorySink,
  EVALS_WORKFLOW_PATH,
  type EvalProfile,
  eject,
  formatRegenerationSummary,
  type GeneratedFile,
  isScaffoldPath,
  ownerForPath,
  type Plan,
  planRegeneration,
  regenerate,
  scaffoldCi,
  scaffoldEvals,
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

  const file = scaffoldEvals(EVAL_PROFILE);

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
    expect(gated).toHaveLength(EVAL_PROFILE.suites.length);
  });

  it('omits the credential guard when every model is a fake', () => {
    const fakeOnly = scaffoldEvals({ ...EVAL_PROFILE, secrets: [] });
    expect(fakeOnly.content).not.toContain('id: creds');
    expect(fakeOnly.content).not.toContain('::error::');
    for (const suite of EVAL_PROFILE.suites) {
      expect(fakeOnly.content).toContain(`run: ${suite.command}`);
    }
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
