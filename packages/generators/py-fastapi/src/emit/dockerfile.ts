/**
 * `app/generated/Dockerfile`: the image a deployment that runs one runs.
 *
 * `deployments` is the only part of the IR that says where the app runs, so it is the
 * only thing that decides whether an image is emitted at all. A project that declares
 * no `container` or `batch` deployment gets no Dockerfile -- an image nothing deploys is
 * a file a reader has to explain, and `aid gen` would keep it byte-identical forever.
 *
 * One image serves both: a `container` deployment runs it as a server and a `batch`
 * deployment runs it as a job. The difference is the entrypoint, and the job's is
 * `app.generated.batch`, which reads one request from stdin and exits -- the same image
 * would answer forever otherwise. A build that has a container deployment keeps the
 * server as its default command, because that is what `docker run` should do, and a job
 * definition overrides it.
 *
 * The file lives under `app/generated/` because that is the tier the generator may
 * overwrite: the path is recorded in `aid.manifest.json` and hashed like every other
 * generated file, so a hand edit is drift rather than a silent difference. The image is
 * built from the application root, because the build needs `pyproject.toml`, which sits
 * above `app/`; the header carries the exact command.
 *
 * `app/main.py` belongs to the application, not to this generator, so the server
 * entrypoint is `app.main:app` -- the same ASGI app the developer runs locally. Nothing
 * in the spec becomes a build argument: a declared secret is read from the environment
 * when a model is called, so no layer can carry one.
 */

import type { IR } from '@aid-framework/ir';

import { banner } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';

export const DOCKERFILE_PATH = `${GENERATED_ROOT}/Dockerfile`;

/** The interpreter the emitted code targets; `pyproject.toml` requires the same floor. */
const PYTHON_IMAGE = 'python:3.11-slim';

/** The port the image listens on when the platform does not set `PORT`. */
const DEFAULT_PORT = 8080;

/** Whether any deployment runs an image: a `container` server or a `batch` job. */
export function hasImageDeployment(ir: IR): boolean {
  return ir.deployments.some(
    (deployment) => deployment.target === 'container' || deployment.target === 'batch',
  );
}

/** Code-unit ordering, never `localeCompare`, so the header is byte-identical everywhere. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The ids and targets of the deployments this image serves, in canonical order. */
function imageIds(ir: IR): { id: string; target: string }[] {
  return ir.deployments
    .filter(
      (deployment) =>
        deployment.target === 'container' ||
        (deployment.target === 'batch' && deployment.pipeline !== undefined),
    )
    .map((deployment) => ({ id: deployment.id, target: deployment.target }))
    .sort((left, right) => compareIds(left.id, right.id));
}

/** Every secret a deployment declares, in canonical order. */
function declaredSecrets(ir: IR): string[] {
  const names = new Set<string>();
  for (const deployment of ir.deployments) {
    if (deployment.target !== 'container' && deployment.target !== 'batch') continue;
    for (const name of deployment.secrets) names.add(name);
  }
  return [...names].sort(compareIds);
}

/** Why nothing in the spec is a build argument, phrased for the secrets it names. */
function secretsNote(secrets: readonly string[]): string {
  const [only, ...rest] = secrets;
  if (only === undefined) {
    return (
      'The spec declares no secret, and a model key it does name is read from the ' +
      'environment at call time.'
    );
  }
  if (rest.length === 0) {
    return (
      `${only} is read from the environment at call time, so it never reaches a layer ` +
      'and is never a build argument.'
    );
  }
  return (
    `${secrets.join(', ')} are read from the environment at call time, so none of them ` +
    'reaches a layer and none is a build argument.'
  );
}

/** Wrap a sentence as comment lines, so a long secret list cannot outgrow the header. */
function commentBlock(text: string): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') {
      line = `# ${word}`;
      continue;
    }
    if (`${line} ${word}`.length > 88) {
      lines.push(line);
      line = `# ${word}`;
      continue;
    }
    line = `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines.join('\n');
}

export function emitDockerfile(ir: IR): EmittedFile {
  const ids = imageIds(ir);
  const secrets = declaredSecrets(ir);
  const exposed = secrets.map((name) => `-e ${name}=...`).join(' ');
  const onlyContainers = ids.every((entry) => entry.target === 'container');
  const imageLine = onlyContainers
    ? `# The image for ${ids.map((entry) => `deployments.${entry.id}`).join(', ')} ` +
      '(`target: container`).'
    : `# The image for ${ids
        .map((entry) => `deployments.${entry.id} (\`target: ${entry.target}\`)`)
        .join(', ')}.`;
  const serves = ids.some((entry) => entry.target === 'container');
  const jobs = ids.some((entry) => entry.target === 'batch');
  const run = serves
    ? `#   docker run --rm -p ${DEFAULT_PORT}:${DEFAULT_PORT} ` +
      `${exposed}${exposed === '' ? '' : ' '}${ir.project.name}`
    : `#   docker run --rm -i ${exposed}${exposed === '' ? '' : ' '}${ir.project.name} ` +
      '< request.json';

  // One image, two entrypoints. The server is the default when anything serves HTTP,
  // because that is what running the image by hand should do; a job definition replaces
  // it with `app.generated.batch` and hands it the request on stdin.
  const entrypoint = serves
    ? [
        "# `app/main.py` is the application's own file, which is why the image runs",
        '# `app.main:app` instead of an entrypoint the generator invented.',
        ...(jobs
          ? [
              '#',
              '# A `batch` deployment is the same image with its entrypoint replaced: a job',
              '# reads one request from stdin and exits instead of answering until stopped.',
            ]
          : []),
      ]
    : [
        '# A `batch` deployment runs to completion, so the image is its job rather than a',
        '# server: `app.generated.batch` reads one request from stdin, prints the answer and',
        '# exits. The interpreter starts it as a module because it imports the app by',
        '# package name; running the file by path would not resolve those imports.',
      ];

  const serving = serves
    ? [
        `ENV PORT=${DEFAULT_PORT}`,
        `EXPOSE ${DEFAULT_PORT}`,
        '',
        "# `exec` replaces the shell with uvicorn, so the platform's SIGTERM reaches the process",
        '# that has to drain in-flight requests rather than stopping at an unresponsive shell.',
        `CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \\"\${PORT}\\""]`,
      ]
    : [
        // Exec form, so the platform's own command appends arguments -- which is how a
        // build that deploys several pipelines says which one this job runs.
        `ENTRYPOINT ["python", "-m", "app.generated.batch"]`,
      ];

  const lines = [
    banner(),
    '#',
    imageLine,
    '#',
    '# Build from the application root -- the build needs `pyproject.toml` and the readme',
    '# it names, both of which sit above `app/`, so the context is the project root and',
    '# this file is named with `-f`:',
    '#',
    `#   docker build -f ${DOCKERFILE_PATH} -t ${ir.project.name} .`,
    run,
    '#',
    ...entrypoint,
    '#',
    commentBlock(secretsNote(secrets)),
    '',
    `FROM ${PYTHON_IMAGE}`,
    '',
    '# An unhandled error has to reach the platform log, and a stdout buffer that dies with',
    '# the process does not. Bytecode is never written at run time, so a platform that',
    '# mounts the root filesystem read-only stays supported.',
    'ENV PYTHONUNBUFFERED=1 \\',
    '    PYTHONDONTWRITEBYTECODE=1 \\',
    '    PIP_DISABLE_PIP_VERSION_CHECK=1 \\',
    '    PIP_NO_CACHE_DIR=1',
    '',
    'WORKDIR /srv',
    '# `pyproject.toml` is the packaging metadata and `README.md` is the readme it points',
    '# at; `app/` is what `[tool.setuptools.packages.find]` installs.',
    'COPY pyproject.toml README.md ./',
    'COPY app ./app',
    'RUN pip install .',
    '',
    '# Not root: the process answers model traffic over the network, and a break-out should',
    '# not start from uid 0.',
    'RUN useradd --create-home --uid 10001 aid',
    'USER aid',
    '',
    ...serving,
    '',
  ];

  return generated(DOCKERFILE_PATH, lines.join('\n'));
}
